'use strict';

// Regression coverage for the two defects that made `service install` produce a
// task that could never boot:
//
//   1. STAGED_FILES omitted src/supervisor/service-logging.js, so the staged
//      entry died with `Cannot find module '../src/supervisor/service-logging'`.
//   2. Nothing provisioned ~/.ai-or-die/bin/ai-or-die-server, and the supervisor
//      spawned the server as `node <binary>`, so the Service either could not
//      find a binary at all or parsed a PE image as JavaScript.
//
// These tests stage a REAL tree into a temp dir and boot it. The staged tree has
// no node_modules, so the stand-in server must be dependency-free — using
// test/fixtures/mock-supervised-server.js here (it requires ws + uuid) would
// reintroduce exactly the failure the test exists to catch.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { ServiceInstaller, STAGED_FILES } = require('../src/supervisor/service-installer');
const {
  auditClosure, assertStagedClosure, extractSpecifiers, listRequires, resolveRelative, stripComments,
} = require('../src/supervisor/staged-closure');
const { ServerManager } = require('../src/supervisor/server-manager');

const REPO = path.resolve(__dirname, '..');

function silent() {
  return { log() {}, info() {}, warn() {}, error() {}, debug() {} };
}

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aod-staging-'));
}

function installerFor(dir, extra = {}) {
  return new ServiceInstaller({
    platform: 'linux',
    homedir: path.join(dir, 'home'),
    baseDir: path.join(dir, 'aod'),
    stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
    metaFile: path.join(dir, 'aod', 'service.json'),
    execFileSync: () => Buffer.from(''),
    spawnSync: () => ({ status: 0, stdout: '' }),
    logger: silent(),
    provisionServer: (ctx) => ({
      provisioned: true,
      path: ctx.dest,
      version: '0.1.112',
      sha256: 'stub',
      verified: 'stub',
      releaseTag: 'v0.1.112',
    }),
    ...extra,
  });
}

// A dependency-free stand-in for the SEA server: speaks the supervisor's IPC
// contract (READY, shutdown, exit-75 restart) using only built-ins.
const STANDIN_SERVER = `'use strict';
if (process.send) process.send({ type: 'ready', pid: process.pid, version: '0.1.112' });
process.on('message', (msg) => {
  if (msg && msg.type === 'shutdown') { process.exit(0); }
});
setInterval(() => {}, 1000);
`;

describe('service staging closure', function () {
  it('ships every relative require the staged entry needs', function () {
    const dir = sandbox();
    try {
      const inst = installerFor(dir);
      const staged = inst.ensureStableBinary(path.join(REPO, 'bin', 'supervisor-service.js'));
      assert.ok(fs.existsSync(staged.path), 'staged entry exists');
      // The exact module PR #172 forgot.
      assert.ok(
        fs.existsSync(path.join(dir, 'aod', 'src', 'supervisor', 'service-logging.js')),
        'service-logging.js is staged'
      );
      // The verifier the installer runs must also pass on its own output.
      const audit = auditClosure(staged.path, { rootDir: path.join(dir, 'aod') });
      assert.deepStrictEqual(audit.missing, [], 'no unresolvable relative requires');
      assert.deepStrictEqual(audit.bare, [], 'no unloadable bare modules');
      assert.ok(audit.checked > 10, `walked the tree (checked=${audit.checked})`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to write a unit when the closure is incomplete', function () {
    const dir = sandbox();
    try {
      // Stage a full tree, then prove the guard catches the exact defect that
      // shipped in PR #172: a staged tree missing service-logging.js updates
      // without complaint and dies at the next Task start.
      const inst = installerFor(dir);
      const staged = inst.ensureStableBinary(path.join(REPO, 'bin', 'supervisor-service.js'));
      const home = path.join(dir, 'aod');
      fs.rmSync(path.join(home, 'src', 'supervisor', 'service-logging.js'), { force: true });
      assert.throws(
        () => assertStagedClosure(staged.path, { rootDir: home }),
        /staged tree is incomplete[\s\S]*service-logging/,
        'the closure guard names the missing module'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails the install instead of registering an unbootable task', function () {
    const dir = sandbox();
    try {
      // Package tree containing every staged file EXCEPT service-logging.js.
      const pkg = path.join(dir, 'pkg');
      for (const [pkgRel] of STAGED_FILES) {
        if (pkgRel.endsWith('service-logging.js')) continue;
        const dest = path.join(pkg, pkgRel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(REPO, pkgRel), dest);
      }
      const inst = installerFor(dir, {
        packageRoot: pkg,
        stableSupervisor: path.join(dir, 'aod', 'bin', 'ai-or-die-supervisor.js'),
      });
      assert.throws(
        () => inst.ensureStableBinary(path.join(pkg, 'bin', 'supervisor-service.js')),
        // Two layers refuse an incomplete package: the STAGED_FILES existence
        // check ("package file missing: …service-logging.js") and, for gaps the
        // explicit list cannot know about, the closure walker.
        /service-logging\.js|staged tree is incomplete/,
        'an incomplete package is refused'
      );
      assert.ok(!fs.existsSync(path.join(dir, 'aod', 'ai-or-die.service')), 'no unit written');
      assert.ok(!fs.existsSync(path.join(dir, 'aod', 'ai-or-die-task.xml')), 'no task xml written');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores requires inside comments and strings', function () {
    const src = [
      "// const x = require('./not-a-real-file');",
      '/*',
      "require('./also-not-real');",
      '*/',
      "const url = 'https://example.com/a';",
      "const real = require('./real');",
    ].join('\n');
    const specs = listRequires(src).map((r) => r.spec);
    assert.deepStrictEqual(specs, ['./real']);
    assert.ok(!stripComments(src).includes('not-a-real-file'));
  });

  it('a regex literal cannot blind the scanner to a real dependency', function () {
    // The old comment stripper treated `/['"]/` as the start of a string, then
    // scanned quoted PROSE for the rest of the file while skipping the real
    // requires. That silently certifies a broken tree.
    const src = [
      "const QUOTE = /['\"]/;",
      'const doc = "require(\'./inside-a-string\')";',
      "const real = require('./real');",
    ].join('\n');
    assert.deepStrictEqual(extractSpecifiers(src).map((r) => r.spec), ['./real']);
  });

  it('covers every module-loading form, not just require(string)', function () {
    const src = [
      "const a = require('./a');",
      "const b = require.resolve('./b');",
      "const c = import('./c');",
      "import d from './d';",
      "const e = require(`./e`);",
      "const t = `x ${require('./f')} require('./not-real')`;",
      "obj.require('./not-a-load');",
      "foo.import('./also-not-a-load');",
    ].join('\n');
    // A missed form is a MODULE_NOT_FOUND at next boot, hours after install.
    assert.deepStrictEqual(
      extractSpecifiers(src).map((r) => r.spec).sort(),
      ['./a', './b', './c', './d', './e', './f']
    );
  });

  it('an unterminated quote on one line does not corrupt the rest of the file', function () {
    const src = [
      "const broken = 'don't do this;",
      "const real = require('./real');",
    ].join('\n');
    assert.ok(extractSpecifiers(src).some((r) => r.spec === './real'));
  });

  // Each form below is a hole the old tokenizer left open: the specifier was
  // never recorded, so the audit certified a tree that dies at the next boot.
  it('records module.require(...) but not a plain property called require', function () {
    const src = [
      "const a = module.require('./from-module');",
      // Negative controls: `obj.require` is a method on some object, not a
      // module load, and a chained `x.module.require` is not the real `module`.
      "foo.require('./not-a-load');",
      "bar.module.require('./also-not-a-load');",
    ].join('\n');
    assert.deepStrictEqual(extractSpecifiers(src).map((r) => r.spec), ['./from-module']);
  });

  it('records optional-call requires (require?. and require.resolve?.)', function () {
    const src = [
      "const a = require?.('./opt');",
      "const b = require.resolve?.('./opt-resolve');",
      // Whitespace between `?.` and the argument list is legal in real code.
      "const c = require ?. ('./opt-spaced');",
    ].join('\n');
    assert.deepStrictEqual(
      extractSpecifiers(src).map((r) => r.spec),
      ['./opt', './opt-resolve', './opt-spaced']
    );
  });

  it('skips a call argument list to its own closing paren, not the first one', function () {
    // The ')' inside the quoted argument used to be taken as the end of the
    // require() call: the scanner resumed mid-string, read the rest of the line
    // as string content, and never saw the second (real) require.
    const src = "const helper = require(path.join(HOME, 'Program Files (x86)', 'helper')), "
      + "tail = require('./tail');";
    assert.deepStrictEqual(extractSpecifiers(src).map((r) => r.spec), ['./tail']);
  });

  it('gives up locally on an unbalanced closer instead of eating the file', function () {
    // A stray '}' cannot be understood, so the argument scan stops there; the
    // outer scan must still see the requires that follow it rather than
    // resuming inside a phantom argument list.
    const src = "const x = require(a } (b), require('./tail'));\nconst real = require('./real');";
    assert.deepStrictEqual(extractSpecifiers(src).map((r) => r.spec), ['./tail', './real']);
  });

  it('resolves .json and .node targets that a staged tree can carry', function () {
    const dir = sandbox();
    try {
      // The staged tree ships a minimal package.json and can ship a native
      // addon; neither needs node_modules, so a missing resolver entry reports
      // a file that IS present as missing and refuses a valid install.
      fs.writeFileSync(path.join(dir, 'manifest.json'), '{}\n');
      fs.writeFileSync(path.join(dir, 'addon.node'), '');
      const from = path.join(dir, 'entry.js');
      fs.writeFileSync(from, '');
      assert.strictEqual(resolveRelative(from, './manifest'), path.join(dir, 'manifest.json'));
      assert.strictEqual(resolveRelative(from, './addon'), path.join(dir, 'addon.node'));
      assert.strictEqual(resolveRelative(from, './absent'), null, 'a real gap is still a gap');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs a staged tree at boot (the MODULE_NOT_FOUND class of bug)', async function () {
    const dir = sandbox();
    let child;
    try {
      const inst = installerFor(dir);
      const staged = inst.ensureStableBinary(path.join(REPO, 'bin', 'supervisor-service.js'));
      // Stand-in server binary: a .js file the supervisor runs under node.
      const serverPath = path.join(dir, 'standin-server.js');
      fs.writeFileSync(serverPath, STANDIN_SERVER);
      const home = path.join(dir, 'aod');
      const heartbeatFile = path.join(home, 'run', 'heartbeat.json');
      const child = spawn(process.execPath, [staged.path, '--port', '0'], {
        env: {
          ...process.env,
          AIORDIE_SERVICE: '1',
          AIORDIE_SERVER_BIN: serverPath,
          AIORDIE_HEARTBEAT_MS: '200',
          AI_OR_DIE_HOME: home,
          AIORDIE_DISABLE_KEEPALIVE: '1',
          AIORDIE_DISABLE_HIBERNATION: '1',
          AIORDIE_AUTO_UPDATE: '0',
          AI_OR_DIE_SESSION_DIR: path.join(dir, 'sessions'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => { out += String(d); });
      child.stderr.on('data', (d) => { out += String(d); });

      const deadline = Date.now() + 25000;
      let hb = null;
      while (Date.now() < deadline) {
        try {
          hb = JSON.parse(fs.readFileSync(heartbeatFile, 'utf8'));
          if (hb && hb.phase === 'ready') break;
        } catch (_) { /* not yet */ }
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(hb, `staged tree wrote a heartbeat; output was:\n${out}`);
      assert.strictEqual(hb.phase, 'ready', `staged tree reached READY; output was:\n${out}`);
      assert.ok(hb.pid > 0, 'heartbeat carries the supervisor pid');
      assert.ok(!/MODULE_NOT_FOUND|Cannot find module/.test(out), `no module errors:\n${out}`);
    } finally {
      try { if (child) child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('server binary spawn strategy', function () {
  it('execs a SEA binary directly and never prefixes it with node', function () {
    const sea = process.platform === 'win32'
      ? 'C:\\Users\\u\\.ai-or-die\\bin\\ai-or-die-server.exe'
      : '/home/u/.ai-or-die/bin/ai-or-die-server';
    const cmd = ServerManager.childCommand(sea, ['--port', '7777']);
    assert.strictEqual(cmd.file, sea, 'binary is the executable');
    assert.deepStrictEqual(cmd.argv, ['--port', '7777'], 'no script indirection');
    assert.ok(!cmd.argv.includes(sea), 'binary is not repeated as a script arg');
  });

  it('keeps node --expose-gc for a .js server target', function () {
    const cmd = ServerManager.childCommand('/repo/test/fixtures/mock-supervised-server.js', ['--port', '7777']);
    assert.strictEqual(cmd.file, process.execPath);
    assert.deepStrictEqual(cmd.argv, ['--expose-gc', '/repo/test/fixtures/mock-supervised-server.js', '--port', '7777']);
  });

  it('spawns through the computed command', async function () {
    const seen = [];
    const EventEmitter = require('events');
    const proc = new EventEmitter();
    proc.pid = 4242;
    proc.killed = false;
    proc.connected = true;
    proc.send = () => {};
    proc.kill = () => { proc.killed = true; };
    const mgr = new ServerManager({
      spawn: (file, argv) => { seen.push({ file, argv }); return proc; },
      readyTimeoutMs: 1000,
    });
    const pending = mgr.spawnServer('/opt/ai-or-die/bin/ai-or-die-server', ['--mesh']);
    proc.emit('message', { type: 'ready', pid: 4242, version: '0.1.112' });
    await pending;
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].file, '/opt/ai-or-die/bin/ai-or-die-server');
    assert.deepStrictEqual(seen[0].argv, ['--mesh']);
  });
});

describe('STAGED_FILES integrity', function () {
  it('every staged source path exists in the package', function () {
    for (const [pkgRel] of STAGED_FILES) {
      assert.ok(fs.existsSync(path.join(REPO, pkgRel)), `missing package file: ${pkgRel}`);
    }
  });

  it('the staged entry is the file the unit launches', function () {
    const dir = sandbox();
    try {
      const inst = installerFor(dir);
      const staged = inst.ensureStableBinary(path.join(REPO, 'bin', 'supervisor-service.js'));
      assert.strictEqual(path.basename(staged.path), 'ai-or-die-supervisor.js');
      // A real assertion of the closure, independent of the installer's own guard.
      assertStagedClosure(staged.path, { rootDir: path.join(dir, 'aod') });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
