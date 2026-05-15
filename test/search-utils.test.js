// Unit tests for src/utils/search.js — focused on the per-line + per-buffer
// caps added in the bde844f DoS fix-up. We don't shell out to rg/grep here;
// we exercise the public searchStream() with a "fake" backend by injecting
// a controlled producer process. For the cap behaviour specifically, we
// drive the stream by mocking child_process.spawn via require() rewiring.
//
// REUSE NOTE: the fake-spawn + controllable-Readable-stdout pattern below
// (makeFakeChild, withFakeSpawn, loadSearchWithStubbedExec) is reusable for
// any test that needs to exercise a child_process consumer without spawning
// a real binary. Extracting it into a shared helper at
// `test/helpers/fake-child-process.js` is tracked in
// https://github.com/animeshkundu/ai-or-die/issues/98.

const assert = require('assert');
const { Readable, EventEmitter } = require('stream');
const path = require('path');
const Module = require('module');
const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// Module-level rewire: replace child_process.spawn with a controllable stub
// for the duration of the cap-behaviour test, then restore. This lets us
// inject pathological stdout streams into searchStream() without depending
// on rg/grep being installed and without contriving a real long-line file.
// ---------------------------------------------------------------------------
const realCp = require('child_process');
const realSpawn = realCp.spawn;

function makeFakeChild(stdoutChunks /* Array<string|Buffer> */, exitCode) {
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.killed = false;
  child.kill = function () { child.killed = true; };

  // Push chunks asynchronously to mimic real process IO.
  setImmediate(() => {
    for (const c of stdoutChunks) stdout.push(c);
    stdout.push(null);
    stderr.push(null);
    setImmediate(() => child.emit('close', exitCode || 0));
  });

  return child;
}

function withFakeSpawn(producerFn, fn) {
  // Re-evaluate src/utils/search.js with a stubbed child_process.
  // We use Module._cache invalidation since search.js caches the spawn ref
  // via destructuring at top-of-file.
  const searchPath = require.resolve('../src/utils/search');
  delete require.cache[searchPath];

  // Stub child_process.spawn at the module level so the fresh require()
  // picks up the patched version.
  realCp.spawn = function (cmd, args, opts) { return producerFn(cmd, args, opts); };
  // Pretend rg is installed so detectBackend() returns 'rg' — we stub
  // execFileSync to succeed for `which rg`.
  const realExecFileSync = realCp.execFileSync;
  realCp.execFileSync = function (cmd, args /*, opts */) {
    if (cmd === 'which' && Array.isArray(args) && /^rg/.test(args[0] || '')) return Buffer.from('/fake/bin/rg\n');
    if (cmd === 'where' && Array.isArray(args) && /^rg/.test(args[0] || '')) return Buffer.from('C:\\fake\\rg.exe\n');
    return realExecFileSync.apply(realCp, arguments);
  };

  try {
    const search = require('../src/utils/search');
    search.resetBackendDetection();
    return fn(search);
  } finally {
    realCp.spawn = realSpawn;
    realCp.execFileSync = realExecFileSync;
    delete require.cache[searchPath];
  }
}

// Helper: build a fake rg --json match event line.
function fakeRgMatch(filePath, lineNum, text) {
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: filePath },
      lines: { text: text + '\n' },
      line_number: lineNum,
      submatches: [{ match: { text: 'x' }, start: 0, end: 1 }],
    },
  });
}

describe('utils/search — DoS hardening (bde844f fix-up)', function () {
  this.timeout(5000);

  it('drops single lines exceeding MAX_LINE_BYTES without parsing', function (done) {
    const big = 'x'.repeat(300 * 1024); // 300 KB > 256 KB cap
    const oversized = fakeRgMatch('big.js', 1, big);

    const matches = [];
    let endResult = null;
    let errorCount = 0;

    withFakeSpawn(
      () => makeFakeChild([oversized + '\n', fakeRgMatch('ok.js', 5, 'ok') + '\n'], 0),
      (search) => {
        search.searchStream('foo', {
          cwd: '/tmp',
          maxPerFile: 10,
          maxTotal: 100,
          onMatch: (m) => matches.push(m),
          onError: () => errorCount++,
          onEnd: (r) => {
            endResult = r;
            try {
              // The oversized line was dropped; the second valid match got through.
              assert.strictEqual(matches.length, 1, 'expected exactly 1 match');
              assert.strictEqual(matches[0].path, 'ok.js');
              assert.strictEqual(matches[0].line, 5);
              assert.strictEqual(endResult.droppedLines, 1, 'expected 1 dropped line');
              assert.strictEqual(errorCount, 0, 'oversized lines should NOT trigger onError');
              done();
            } catch (e) { done(e); }
          },
        });
      }
    );
  });

  it('emergency-cap kicks in for stream with no newline at all', function (done) {
    // 5 MB chunk with no \n → exceeds MAX_STDOUT_BUF_BYTES (4 MB). The
    // searchStream must abort cleanly via onError + onEnd, never freeze.
    const huge = 'x'.repeat(5 * 1024 * 1024);

    let saw = { match: 0, error: 0, end: null };
    withFakeSpawn(
      () => makeFakeChild([huge], 0),
      (search) => {
        search.searchStream('foo', {
          cwd: '/tmp',
          onMatch: () => saw.match++,
          onError: () => saw.error++,
          onEnd: (r) => {
            saw.end = r;
            try {
              assert.strictEqual(saw.match, 0);
              assert.ok(saw.error >= 1, 'expected at least one error event');
              assert.ok(saw.end.droppedLines >= 1, 'expected droppedLines >= 1');
              done();
            } catch (e) { done(e); }
          },
        });
      }
    );
  });

  it('long line spread across many chunks: switches into skip mode without unbounded growth', function (done) {
    // Build a single ~400 KB line delivered in 100 small chunks.
    const chunkSize = 4 * 1024;
    const numChunks = 100;
    const chunks = [];
    for (let i = 0; i < numChunks; i++) chunks.push('x'.repeat(chunkSize));
    chunks.push('\n');                                // terminate the bad line
    chunks.push(fakeRgMatch('ok.js', 1, 'goodmatch') + '\n');

    const matches = [];
    withFakeSpawn(
      () => makeFakeChild(chunks, 0),
      (search) => {
        search.searchStream('foo', {
          cwd: '/tmp',
          onMatch: (m) => matches.push(m),
          onError: () => {},
          onEnd: (r) => {
            try {
              // The bad line is dropped; the good match still arrives.
              assert.strictEqual(matches.length, 1, 'expected the good match to survive');
              assert.strictEqual(matches[0].path, 'ok.js');
              assert.ok(r.droppedLines >= 1, 'expected at least 1 dropped line');
              done();
            } catch (e) { done(e); }
          },
        });
      }
    );
  });

  it('rg argv includes --max-columns and --max-columns-preview', function () {
    const search = require('../src/utils/search');
    const { args } = search._buildRgArgs('foo', { cwd: '/tmp' });
    assert.ok(args.includes('--max-columns'), '--max-columns must be in argv');
    const idx = args.indexOf('--max-columns');
    assert.strictEqual(args[idx + 1], String(search._MAX_RG_COLUMNS),
      '--max-columns value must match exported constant');
    assert.ok(args.includes('--max-columns-preview'),
      '--max-columns-preview must be in argv');
  });

  it('grep argv includes -- separator before positional path', function () {
    const search = require('../src/utils/search');
    const { args } = search._buildGrepArgs('foo', { cwd: '/tmp/abs' });
    const dashIdx = args.lastIndexOf('--');
    assert.ok(dashIdx > 0, '-- separator must be present in grep argv');
    assert.strictEqual(args[dashIdx + 1], '/tmp/abs',
      '-- must immediately precede the positional path');
  });

  it('grep argv uses -Z (NUL separator) so filenames with :digits: parse correctly', function () {
    const search = require('../src/utils/search');
    const { args } = search._buildGrepArgs('foo', { cwd: '/tmp' });
    // grep accepts -Z either alone or merged into compound short opts.
    const hasZFlag = args.some((a) => a === '-Z' || (a.startsWith('-') && !a.startsWith('--') && a.includes('Z')));
    assert.ok(hasZFlag, 'grep argv must include -Z for NUL-separated paths');
  });
});

describe('utils/search — backend detection (bde844f MEDIUM-2)', function () {
  // The search module destructures execFileSync at top-of-file, so the
  // closure captures the ORIGINAL function. To make our monkey-patches
  // visible to the module's detection code we must (a) monkey-patch
  // FIRST, then (b) clear the require cache and re-require search.js so
  // it captures our patched execFileSync.
  //
  // ADR-0018 update: detection now ALSO consults @vscode/ripgrep's
  // bundled binary BEFORE falling back to grep. Tests that want to
  // exercise the "no rg anywhere" path must therefore stub BOTH:
  //   - execFileSync (system PATH lookup)
  //   - fs.accessSync (bundled-binary X_OK check)
  // The stubFsAccess helper below makes the bundled binary appear
  // unexecutable; the production X_OK check then throws and detection
  // falls through to grep / null exactly as before.
  function loadSearchWithStubbedExec(stubbedExec, platform, opts) {
    opts = opts || {};
    const bundledAvailable = opts.bundledAvailable === true;
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    const realExec = realCp.execFileSync;
    realCp.execFileSync = stubbedExec;

    // Patch fs.accessSync ONLY for the bundled @vscode/ripgrep path —
    // leave every other accessSync call (read-checks elsewhere in the
    // module graph) untouched.
    const realAccessSync = fs.accessSync;
    fs.accessSync = function (target, mode) {
      // Detect the bundled-rg liveness check: target ends with rg/rg.exe
      // AND lives under node_modules/@vscode/ripgrep. We cannot rely on
      // exact path equality because the platform-specific suffix varies
      // (ripgrep-darwin-arm64 vs ripgrep-linux-x64 vs ripgrep-win32-x64).
      const looksLikeBundledRg =
        typeof target === 'string' &&
        /[\\/]node_modules[\\/]@vscode[\\/]ripgrep/.test(target);
      if (looksLikeBundledRg) {
        if (bundledAvailable) return undefined;
        const e = new Error('EACCES: permission denied'); e.code = 'EACCES';
        throw e;
      }
      return realAccessSync.apply(fs, arguments);
    };

    const searchPath = require.resolve('../src/utils/search');
    delete require.cache[searchPath];
    const search = require(searchPath);
    return {
      search: search,
      restore: function () {
        realCp.execFileSync = realExec;
        fs.accessSync = realAccessSync;
        Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
        delete require.cache[searchPath];
      },
    };
  }

  it('refuses to fall back to grep on macOS (Homebrew ugrep risk)', function () {
    const ctx = loadSearchWithStubbedExec(function (cmd, args) {
      if (cmd === 'which' && args[0] === 'rg') {
        const e = new Error('rg not found'); e.status = 1; throw e;
      }
      if (cmd === 'which' && args[0] === 'grep') return Buffer.from('/usr/bin/grep\n');
      throw new Error('unexpected execFileSync call: ' + cmd + ' ' + args.join(' '));
    }, 'darwin', { bundledAvailable: false });
    try {
      const backend = ctx.search.detectBackend();
      assert.strictEqual(backend, null,
        'macOS detection MUST return null when neither system nor bundled rg is usable (no grep fallback)');
    } finally {
      ctx.restore();
    }
  });

  it('falls back to grep on linux when rg is absent', function () {
    const ctx = loadSearchWithStubbedExec(function (cmd, args) {
      if (cmd === 'which' && args[0] === 'rg') {
        const e = new Error('rg not found'); e.status = 1; throw e;
      }
      if (cmd === 'which' && args[0] === 'grep') return Buffer.from('/usr/bin/grep\n');
      throw new Error('unexpected: ' + cmd);
    }, 'linux', { bundledAvailable: false });
    try {
      assert.strictEqual(ctx.search.detectBackend(), 'grep');
    } finally {
      ctx.restore();
    }
  });

  it('refuses to fall back to grep on Windows', function () {
    const ctx = loadSearchWithStubbedExec(function (cmd, args) {
      if (cmd === 'where' && /^rg/.test(args[0])) {
        const e = new Error('rg not found'); e.status = 1; throw e;
      }
      if (cmd === 'where' && args[0] === 'grep') return Buffer.from('C:\\fake\\grep.exe\n');
      throw new Error('unexpected: ' + cmd);
    }, 'win32', { bundledAvailable: false });
    try {
      assert.strictEqual(ctx.search.detectBackend(), null,
        'Windows detection MUST return null when neither system nor bundled rg is usable (no grep fallback)');
    } finally {
      ctx.restore();
    }
  });

  // --------------------------------------------------------------------
  // ADR-0018: bundled @vscode/ripgrep fallback
  // --------------------------------------------------------------------

  it('falls back to bundled @vscode/ripgrep when system rg is absent (Windows)', function () {
    // Windows has no system rg, no grep fallback. The bundled binary
    // is the ONLY path to a working backend on a stock Windows runner.
    // This test pins the contract that drove the ADR-0018 decision.
    const ctx = loadSearchWithStubbedExec(function (cmd, args) {
      if (cmd === 'where' && /^rg/.test(args[0])) {
        const e = new Error('rg not found'); e.status = 1; throw e;
      }
      // Should never reach grep on Windows — the bundled check should
      // succeed first.
      throw new Error('unexpected: ' + cmd + ' ' + args[0]);
    }, 'win32', { bundledAvailable: true });
    try {
      assert.strictEqual(ctx.search.detectBackend(), 'rg',
        'Windows detection MUST surface backend=rg when bundled binary is usable');
      const rgPath = ctx.search.detectRgPath();
      assert.ok(rgPath && typeof rgPath === 'string',
        'detectRgPath() MUST return the bundled binary path (non-null) so spawn bypasses PATH');
      assert.match(rgPath, /node_modules[\\/]@vscode[\\/]ripgrep/,
        'rgPath MUST point inside @vscode/ripgrep node_modules; got ' + rgPath);
    } finally {
      ctx.restore();
    }
  });

  it('falls back to bundled @vscode/ripgrep when system rg is absent (macOS)', function () {
    // Mirror of the Windows test for macOS-no-Homebrew users — same
    // wire-shape contract.
    const ctx = loadSearchWithStubbedExec(function (cmd, args) {
      if (cmd === 'which' && args[0] === 'rg') {
        const e = new Error('rg not found'); e.status = 1; throw e;
      }
      throw new Error('unexpected: ' + cmd + ' ' + args[0]);
    }, 'darwin', { bundledAvailable: true });
    try {
      assert.strictEqual(ctx.search.detectBackend(), 'rg');
      assert.ok(ctx.search.detectRgPath(), 'detectRgPath() must be set');
    } finally {
      ctx.restore();
    }
  });

  it('system rg takes precedence over bundled rg (preserves user installs)', function () {
    // Order matters — Homebrew/apt/choco rg may be newer than what the
    // bundled npm package ships, OR may have user customizations. The
    // detection must try the system binary FIRST and only fall back if
    // it's missing. detectRgPath() returns null when system rg is in
    // play (spawn uses unqualified 'rg' name + PATH lookup).
    const ctx = loadSearchWithStubbedExec(function (cmd, args) {
      if (cmd === 'which' && args[0] === 'rg') return Buffer.from('/usr/local/bin/rg\n');
      throw new Error('unexpected: ' + cmd);
    }, 'darwin', { bundledAvailable: true });    // bundled is also OK; should NOT be used
    try {
      assert.strictEqual(ctx.search.detectBackend(), 'rg');
      assert.strictEqual(ctx.search.detectRgPath(), null,
        'when system rg is found, detectRgPath() MUST be null so spawn uses PATH');
    } finally {
      ctx.restore();
    }
  });

  it('requireBackendAtStartup() throws NO_SEARCH_BACKEND with actionable guidance when nothing is usable', function () {
    // The hard-error gate (ADR-0018 v1) — refuses to start the server
    // when both system rg AND bundled rg are unavailable AND grep is
    // not on Linux. Operator gets a multi-line install-guidance error
    // instead of cryptic "0 matches" later.
    const ctx = loadSearchWithStubbedExec(function (cmd, args) {
      if (cmd === 'where' && /^rg/.test(args[0])) {
        const e = new Error('rg not found'); e.status = 1; throw e;
      }
      throw new Error('unexpected: ' + cmd + ' ' + args[0]);
    }, 'win32', { bundledAvailable: false });
    try {
      assert.strictEqual(ctx.search.detectBackend(), null,
        'precondition: detection must be null for this scenario');
      let thrown = null;
      try { ctx.search.requireBackendAtStartup(); }
      catch (e) { thrown = e; }
      assert.ok(thrown, 'requireBackendAtStartup() MUST throw when no backend is available');
      assert.strictEqual(thrown.code, 'NO_SEARCH_BACKEND',
        'thrown error MUST set code=NO_SEARCH_BACKEND so callers can pattern-match');
      assert.match(thrown.message, /ripgrep is required/i,
        'message must lead with the install-ripgrep guidance');
      assert.match(thrown.message, /@vscode\/ripgrep/,
        'message must mention re-running npm install for the bundled package');
      assert.match(thrown.message, /brew install ripgrep/,
        'message must include macOS install command');
      assert.match(thrown.message, /apt install ripgrep/,
        'message must include Linux install command');
      assert.match(thrown.message, /choco install ripgrep/,
        'message must include Windows install command');
    } finally {
      ctx.restore();
    }
  });

  it('requireBackendAtStartup() returns the backend name when one is usable', function () {
    const ctx = loadSearchWithStubbedExec(function (cmd, args) {
      if (cmd === 'where' && /^rg/.test(args[0])) {
        const e = new Error('rg not found'); e.status = 1; throw e;
      }
      throw new Error('unexpected: ' + cmd);
    }, 'win32', { bundledAvailable: true });
    try {
      const result = ctx.search.requireBackendAtStartup();
      assert.strictEqual(result, 'rg',
        'when bundled rg is usable, startup gate must return "rg" (not throw)');
    } finally {
      ctx.restore();
    }
  });
});
