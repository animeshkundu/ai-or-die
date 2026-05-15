// src/utils/search.js — Streaming code search wrapper around ripgrep (with
// grep fallback). Used by GET /api/search.
//
// Why streaming: cross-file search results can be 100s-1000s of matches.
// Buffering them on the server before responding wastes memory and delays
// UX. The HTTP endpoint pipes per-match SSE events so the client can render
// incrementally and cancel mid-flight by closing the EventSource.
//
// Why ripgrep (with strict-Linux grep fallback): rg is ~10× faster than
// grep, respects .gitignore by default, has stable JSON output, and ships
// with a single binary on every platform. We bundle rg via @vscode/ripgrep
// so Windows + macOS-no-Homebrew users get a working backend out of the
// box (ADR-0018). System rg is preferred when present; the bundled binary
// is the cross-platform fallback. grep stays as a strict-Linux-only safety
// net for "rg present but unexecutable" edge cases (antivirus quarantine,
// stripped exec bit, corp policy block).

'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// One-time async-safe detection of available search backends.
//
// _detectedBackend  : 'rg' | 'grep' | null (wire-shape value, surfaced in
//                     SSE 'start' event + 'end' event for clients). The
//                     SAME value is used regardless of whether rg comes
//                     from PATH or from the @vscode/ripgrep bundled
//                     binary — keeping the contract backward-compatible.
// _detectedRgPath   : absolute path to the rg binary actually used (only
//                     set when backend === 'rg' AND the bundled fallback
//                     was selected). Read by the spawn() call in
//                     streamSearch — when non-null, spawn passes this
//                     path explicitly instead of relying on PATH lookup
//                     for the unqualified 'rg' name.
let _detectedBackend = null;
let _detectedRgPath = null;
let _detectionDone = false;

function _detectBackend() {
  if (_detectionDone) return _detectedBackend;
  _detectionDone = true;

  const rgName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const which = process.platform === 'win32' ? 'where' : 'which';

  // 1. Try system rg FIRST — preserves users on platforms with newer or
  //    customized ripgrep installs (Homebrew, apt, choco). The spawn
  //    below uses the unqualified name 'rg' (PATH-resolved) by leaving
  //    _detectedRgPath null; spawn's own PATH lookup is fine for this
  //    case.
  try {
    execFileSync(which, [rgName], { stdio: 'ignore', shell: false });
    _detectedBackend = 'rg';
    _detectedRgPath = null;     // PATH-resolved 'rg' at spawn time
    return _detectedBackend;
  } catch (_) { /* not found — try bundled */ }

  // 2. SEA-bundled rg (ADR-0018, Windows-binary boot fix). When the
  //    SEA bootstrap runs (sea-bootstrap.js), it extracts the bundled
  //    @vscode/ripgrep platform-specific binary to a temp dir, chmods
  //    it +x on POSIX, and surfaces the resolved path via the
  //    global.__SEA_RG_PATH__ sentinel. We MUST consult this BEFORE
  //    the require('@vscode/ripgrep') path below, because in SEA mode
  //    the package isn't on disk (no node_modules at runtime) and the
  //    require throws.
  //
  //    The X_OK check here is belt-and-suspenders — sea-bootstrap.js
  //    already chmods the file, but a corrupted asset extraction or
  //    antivirus quarantine of the just-extracted binary could leave
  //    it non-executable. accessSync surfaces that as a fall-through
  //    to grep / null instead of letting spawn fail per-request.
  try {
    if (typeof global !== 'undefined' && global.__SEA_RG_PATH__) {
      fs.accessSync(global.__SEA_RG_PATH__, fs.constants.X_OK);
      _detectedBackend = 'rg';
      _detectedRgPath = global.__SEA_RG_PATH__;
      return _detectedBackend;
    }
  } catch (_) { /* extracted but unexecutable — fall through */ }

  // 3. Fall back to the @vscode/ripgrep bundled binary (npm-install
  //    path). This is the primary backend for Windows + macOS-no-
  //    Homebrew users running from `npm install`; corp machines where
  //    rg isn't on PATH; and CI runners that don't pre-install
  //    ripgrep. The bundled binary is downloaded at `npm install`
  //    time by the @vscode/ripgrep postinstall script (network call
  //    — corp proxies + `--ignore-scripts` are the two failure modes
  //    captured in ADR-0018). When that postinstall SUCCEEDS, the
  //    rgPath returned here is an absolute path inside node_modules;
  //    we verify it actually exists and is executable before
  //    declaring it as our backend.
  //
  //    Track the resolved path in _detectedRgPath so the spawn() call
  //    below can pass it explicitly (bypassing PATH lookup, which on
  //    Windows would never find the bundled binary anyway).
  try {
    // require() can throw if the package is missing entirely (offline
    // install, ripped-out node_modules, --ignore-scripts, OR SEA mode
    // where node_modules isn't extracted) — wrap to keep _detectBackend
    // total-on-error.
    const rgPath = require('@vscode/ripgrep').rgPath;
    if (rgPath && typeof rgPath === 'string') {
      // X_OK: the bundled binary may exist on disk but be non-
      // executable due to chmod stripping (zip extraction on Windows
      // can lose the bit; antivirus quarantine on macOS strips it;
      // corp policy on Windows can block exec entirely). accessSync
      // is the cheapest pre-spawn liveness check — if it throws, fall
      // through to the grep safety net.
      fs.accessSync(rgPath, fs.constants.X_OK);
      _detectedBackend = 'rg';
      _detectedRgPath = rgPath;
      return _detectedBackend;
    }
  } catch (_) { /* package missing OR rgPath unexecutable — fall through */ }

  // 4. grep fallback: STRICT Linux only, AND only as a SAFETY NET for
  //    "rg present-but-unusable" cases that slip past steps 1 + 2
  //    (antivirus quarantine of the bundled binary, perms stripped at
  //    extraction time, corp policy block on the bundled path). grep
  //    is NOT the primary path on any platform under the bundled-rg
  //    design — when this branch hits, search semantics degrade
  //    (no .gitignore awareness, no per-file --max-count, no JSON
  //    output) and the client surfaces backend === 'grep' so the UI
  //    can show a "limited mode" hint.
  //
  //    macOS BSD grep + Homebrew ugrep have incompatible --max-count
  //    and --exclude-dir semantics; rather than probe grep --version
  //    for GNU-grep signature, refuse to fall back at all on macOS
  //    (peer-review MEDIUM-2 on bde844f).
  if (process.platform === 'linux') {
    try {
      execFileSync(which, ['grep'], { stdio: 'ignore', shell: false });
      _detectedBackend = 'grep';
      return _detectedBackend;
    } catch (_) { /* not found */ }
  }

  _detectedBackend = null;
  _detectedRgPath = null;
  return _detectedBackend;
}

/**
 * Re-run backend detection. Useful in tests or after install.
 */
function resetBackendDetection() {
  _detectedBackend = null;
  _detectedRgPath = null;
  _detectionDone = false;
}

/**
 * Synchronous accessor — returns 'rg' | 'grep' | null.
 */
function detectBackend() { return _detectBackend(); }

/**
 * Returns the resolved rg binary path (absolute) when the bundled
 * fallback is in use, or null when system rg (PATH-resolved) is in
 * use. Exposed primarily for test introspection — production code
 * reads _detectedRgPath directly via the spawn() call.
 */
function detectRgPath() {
  _detectBackend();
  return _detectedRgPath;
}

/**
 * Server-startup gate — fail fast with actionable guidance when no
 * backend is available, instead of letting the broken state surface
 * as cryptic "0 matches" UI behaviour later (ADR-0018 v1 design:
 * startup is honest about the broken state rather than silently
 * disabling the search feature).
 *
 * Throws an Error with a multi-line message for the operator. Callers
 * (server.js `start()`) should let the error propagate to abort the
 * boot — recovering with a degraded "search disabled" mode is an
 * explicit non-goal for v1.
 */
function requireBackendAtStartup() {
  const backend = _detectBackend();
  if (backend) return backend;
  const lines = [
    'ripgrep is required for cross-file search.',
    '',
    '  - Verify @vscode/ripgrep installed correctly (re-run `npm install`)',
    '  - OR install rg manually:',
    '      macOS:    brew install ripgrep',
    '      Linux:    apt install ripgrep    (or your distro\'s equivalent)',
    '      Windows:  choco install ripgrep  (or scoop install ripgrep)',
  ];
  const err = new Error(lines.join('\n'));
  err.code = 'NO_SEARCH_BACKEND';
  throw err;
}

// ---------------------------------------------------------------------------
// DoS hardening (peer-review HIGH on bde844f)
// ---------------------------------------------------------------------------
// rg's --json output emits ONE JSON object per match terminated by `\n`.
// The `lines.text` field includes the entire matching line VERBATIM. With
// --max-filesize 10M, a single long-line file (minified bundle, packed
// JSON, generated code in dist/ etc.) can produce a single ~10MB rg JSON
// event. JSON.parse runs synchronously and would block the Node event
// loop for hundreds of milliseconds — any authenticated user could
// trivially DoS the server.
//
// Mitigations applied here:
//   1. Tell rg to truncate matched lines IN ITS OUTPUT via --max-columns
//      and --max-columns-preview (VS Code's pattern). The JSON event
//      still arrives, but `lines.text` is bounded.
//   2. As defence in depth, cap stdoutBuf and the parsed-line size in
//      the consumer loop. Pathological lines (over MAX_LINE_BYTES) are
//      dropped + the entry surfaces as an error event so the user
//      knows results are incomplete.
const MAX_RG_COLUMNS = 512;          // chars per matched line in rg JSON output
const MAX_LINE_BYTES = 256 * 1024;   // hard cap per parsed stdout line (defense in depth)
const MAX_STDOUT_BUF_BYTES = 4 * 1024 * 1024; // emergency cap on accumulated buffer

/**
 * Build the ripgrep argv. Returns { cmd, args }.
 *
 * Hardening:
 *   - All user-controlled values are passed as positional argv items so
 *     they cannot be reinterpreted as flags. We use --regexp=<q> so the
 *     query argument carrying a leading '-' is impossible to misuse, and
 *     --glob=<g> for glob patterns.
 *   - --max-count caps per-file matches; --max-filesize caps per-file
 *     bytes scanned; --json stabilises output format.
 *   - --max-columns + --max-columns-preview cap MATCHED-LINE LENGTH in
 *     the JSON event itself (peer-review HIGH on bde844f). Without this
 *     a 10MB minified-JS file produces a 10MB-per-match JSON line that
 *     blocks the event loop on JSON.parse.
 *   - --no-config prevents per-user .ripgreprc from changing semantics.
 *   - Default behaviour respects .gitignore (which is the desired UX).
 *   - --no-messages suppresses stderr for missing-permission warnings
 *     so they don't pollute the SSE stream.
 */
function _buildRgArgs(query, opts) {
  const args = [
    '--json',
    '--no-config',
    '--no-messages',
    '--max-count', String(opts.maxPerFile || 50),
    '--max-filesize', opts.maxFilesize || '10M',
    '--max-columns', String(MAX_RG_COLUMNS),
    '--max-columns-preview',
  ];
  if (!opts.caseSensitive) args.push('--ignore-case');
  if (!opts.regex) args.push('--fixed-strings');
  if (opts.glob) args.push('--glob', opts.glob);
  // -- separates options from positional args (paranoia: rg also has
  // --regexp= which we use, but extra defence is cheap).
  args.push('--regexp', query);
  // Positional path is `.` (relative) — spawn's cwd is set to opts.cwd
  // already (see streamSearch). rg's `--glob 'foo/*.js'` only matches
  // when the search target is relative (`.`); passing the same absolute
  // path here as positional silently drops directory-prefix globs
  // (reproduced on rg 15.1.0 macOS + Linux CI). Use `.` so the glob root
  // coincides with cwd.
  args.push('--', '.');
  return { cmd: 'rg', args };
}

/**
 * Build the grep argv (Linux fallback).
 *
 * grep doesn't ship with structured output — we emit `<path>\0<line>:<text>`
 * via -n + -Z and parse on the consumer side. The NUL separator (peer-review
 * LOW-1 on bde844f) ensures filenames containing `:digits:` substrings
 * (e.g. `weirdname:42:more.txt`) don't confuse the path/line/text split.
 *
 * Limitations vs ripgrep:
 *   - No native .gitignore awareness. We exclude common heavy dirs
 *     (.git, node_modules) via --exclude-dir. Imperfect but matches
 *     typical user expectations.
 *   - --include for glob is positive-only; --exclude inversion is
 *     not supported. We therefore reject glob patterns starting with
 *     `!` in the route handler.
 *   - --max-count is a global cap, not per-file. We pass the per-file
 *     cap and let the route handler stop reading once its global cap
 *     is reached.
 */
function _buildGrepArgs(query, opts) {
  const args = ['-RInZ', '--color=never'];     // -Z = NUL between path + line:text
  if (!opts.caseSensitive) args.push('-i');
  if (opts.regex) args.push('-E');                 // ERE
  else args.push('-F');                            // fixed strings
  args.push('--max-count', String(opts.maxPerFile || 50));
  args.push('--exclude-dir=.git');
  args.push('--exclude-dir=node_modules');
  args.push('--exclude-dir=.venv');
  args.push('--exclude-dir=.next');
  args.push('--exclude-dir=dist');
  if (opts.glob) args.push('--include', opts.glob);
  args.push('--regexp', query);
  // -- separator before the positional path (peer-review MEDIUM-1 on
  // bde844f — symmetry with rg argv builder; protects against future
  // refactors that might let cwd default to a relative path).
  args.push('--', opts.cwd || '.');
  return { cmd: 'grep', args };
}

/**
 * Stream search results for `query` rooted at `opts.cwd`.
 *
 * @param {string} query
 * @param {object} opts
 *   - cwd:           absolute path to scope search (must be pre-validated by caller)
 *   - regex:         boolean — treat query as regex (default: false → fixed-strings)
 *   - caseSensitive: boolean (default: false)
 *   - glob:          string|null — pre-validated glob pattern (no shell metachars)
 *   - maxPerFile:    int (default 50)
 *   - maxTotal:      int (default 500) — hard cap; killer kills the child when reached
 *   - maxFilesize:   string (default '10M')
 *   - onMatch:       (match) => void; match shape: { path, line, col, text }
 *   - onError:       (err: Error) => void
 *   - onEnd:         ({ matches: int, truncated: boolean, backend, droppedLines: int }) => void
 *
 * @returns {{ kill(): void, backend: string }}
 */
function searchStream(query, opts) {
  if (typeof query !== 'string' || !query.length) {
    throw new TypeError('query must be a non-empty string');
  }
  const onMatch = opts.onMatch || (() => {});
  const onError = opts.onError || (() => {});
  const onEnd = opts.onEnd || (() => {});

  const backend = detectBackend();
  if (!backend) {
    // Surface async to keep callers' contract uniform (always ends).
    setImmediate(() => {
      onError(new Error('No search backend available (install ripgrep)'));
      onEnd({ matches: 0, truncated: false, backend: null, droppedLines: 0 });
    });
    return { kill() {}, backend: null };
  }

  const { cmd, args } = backend === 'rg'
    ? _buildRgArgs(query, opts)
    : _buildGrepArgs(query, opts);

  // When the bundled rg fallback is in use, _detectedRgPath holds the
  // absolute path inside node_modules. Pass it explicitly to spawn() so
  // we don't depend on PATH lookup (which on Windows would never find
  // the bundled binary). When system rg is in use, _detectedRgPath is
  // null and we fall back to the unqualified 'rg' name from
  // _buildRgArgs (PATH-resolved by the OS).
  const spawnCmd = (backend === 'rg' && _detectedRgPath) ? _detectedRgPath : cmd;

  const child = spawn(spawnCmd, args, {
    cwd: opts.cwd || process.cwd(),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let matches = 0;
  let truncated = false;
  let droppedLines = 0;       // count of pathologically long lines we skipped
  let killed = false;
  const maxTotal = opts.maxTotal || 500;

  function killChild() {
    if (killed) return;
    killed = true;
    try { child.kill('SIGTERM'); } catch (_) {}
    // Force-kill if process doesn't exit shortly.
    setTimeout(() => {
      if (!child.killed) try { child.kill('SIGKILL'); } catch (_) {}
    }, 200).unref();
  }

  // Buffer stdout, split on \n, parse per line.
  // Hardened against the HIGH from peer review of bde844f:
  //   - skipUntilNewline: when a single line exceeds MAX_LINE_BYTES we
  //     drain it (drop the buffer up to the next \n) WITHOUT appending
  //     more, then JSON.parse'ing it. This bounds the cost of any one
  //     pathological line.
  //   - MAX_STDOUT_BUF_BYTES is an emergency ceiling: even if rg/grep
  //     produces a stream with no newlines at all, we won't grow the
  //     buffer unbounded. Hitting this cap kills the search.
  let stdoutBuf = '';
  let skipUntilNewline = false;     // true while we're draining a too-long line
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (killed) return;

    // If we're already over the per-line cap, scan ONLY for the next
    // newline; don't bother appending the body to the buffer.
    if (skipUntilNewline) {
      const nl = chunk.indexOf('\n');
      if (nl === -1) return;
      // Resume normal buffering at whatever follows the dropped line.
      skipUntilNewline = false;
      stdoutBuf = chunk.slice(nl + 1);
    } else {
      stdoutBuf += chunk;
    }

    // Emergency: if the buffer has grown past the absolute ceiling without
    // ever seeing a newline, the producer is misbehaving. Kill and bail.
    if (stdoutBuf.length > MAX_STDOUT_BUF_BYTES) {
      droppedLines += 1;
      stdoutBuf = '';
      onError(new Error('search backend produced an oversized line; aborting'));
      killChild();
      return;
    }

    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;

      // Per-line cap (defense in depth on top of rg's --max-columns).
      // grep doesn't have a comparable flag; this is the only line cap.
      if (line.length > MAX_LINE_BYTES) {
        droppedLines += 1;
        continue;
      }

      try {
        if (backend === 'rg') {
          const evt = JSON.parse(line);
          if (evt && evt.type === 'match' && evt.data) {
            const d = evt.data;
            const filePath = d.path && (d.path.text || d.path.bytes);
            const lineNum = d.line_number;
            const text = (d.lines && d.lines.text) || '';
            // Use first submatch start as col if present.
            let col = 1;
            if (Array.isArray(d.submatches) && d.submatches.length) {
              col = (d.submatches[0].start | 0) + 1;
            }
            if (filePath && lineNum != null) {
              matches += 1;
              onMatch({
                path: filePath,
                line: lineNum,
                col: col,
                text: text.replace(/\r?\n$/, ''),
              });
              if (matches >= maxTotal) {
                truncated = true;
                killChild();
                return;
              }
            }
          }
        } else {
          // grep with -Z: <path>\0<line>:<text>
          // NUL-separation (peer-review LOW-1 on bde844f) eliminates the
          // ambiguity when filenames contain `:digits:` substrings.
          const z = line.indexOf('\0');
          if (z === -1) continue;
          const filePath = line.slice(0, z);
          const m = line.slice(z + 1).match(/^(\d+):([\s\S]*)$/);
          if (m && filePath) {
            matches += 1;
            onMatch({
              path: filePath,
              line: parseInt(m[1], 10),
              col: 1,                  // grep doesn't give us a col
              text: m[2],
            });
            if (matches >= maxTotal) {
              truncated = true;
              killChild();
              return;
            }
          }
        }
      } catch (_parseErr) {
        // Bad JSON line — ripgrep occasionally emits non-match events
        // we don't care about; just skip.
      }
    }

    // After draining all complete lines, if the partial-line tail is
    // already over the per-line cap, switch into skip mode so the next
    // chunk doesn't accumulate further. This catches the case where a
    // single long line arrives across many `data` events.
    if (stdoutBuf.length > MAX_LINE_BYTES) {
      droppedLines += 1;
      stdoutBuf = '';
      skipUntilNewline = true;
    }
  });

  child.stderr.setEncoding('utf8');
  let stderrBuf = '';
  // Allocate-bounded version (peer-review LOW-2 on bde844f): cap the
  // INCOMING chunk size BEFORE concatenation so a misbehaving producer
  // emitting a 50MB stderr burst doesn't transiently allocate that
  // much memory.
  const STDERR_CAP = 4096;
  child.stderr.on('data', (chunk) => {
    const room = STDERR_CAP - stderrBuf.length;
    if (room <= 0) return;
    stderrBuf += chunk.length > room ? chunk.slice(0, room) : chunk;
  });

  child.on('error', (err) => {
    if (killed && err.code === 'ABORT_ERR') return;
    onError(err);
  });

  child.on('close', (code) => {
    // ripgrep / grep exit code: 0 = matches found, 1 = no matches, 2 = error.
    // Treat 0 and 1 as success.
    if (code !== 0 && code !== 1 && !killed) {
      const msg = (stderrBuf || '').split('\n')[0].slice(0, 300) || ('exit ' + code);
      onError(new Error(msg));
    }
    onEnd({ matches: matches, truncated: truncated, backend: backend, droppedLines: droppedLines });
  });

  return { kill: killChild, backend: backend };
}

module.exports = {
  searchStream: searchStream,
  detectBackend: detectBackend,
  detectRgPath: detectRgPath,
  requireBackendAtStartup: requireBackendAtStartup,
  resetBackendDetection: resetBackendDetection,
  // Exported for unit tests of the per-line / per-buffer cap logic.
  _MAX_LINE_BYTES: MAX_LINE_BYTES,
  _MAX_RG_COLUMNS: MAX_RG_COLUMNS,
  _buildRgArgs: _buildRgArgs,
  _buildGrepArgs: _buildGrepArgs,
};
