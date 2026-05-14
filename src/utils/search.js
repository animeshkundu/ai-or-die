// src/utils/search.js — Streaming code search wrapper around ripgrep (with
// grep fallback). Used by GET /api/search.
//
// Why streaming: cross-file search results can be 100s-1000s of matches.
// Buffering them on the server before responding wastes memory and delays
// UX. The HTTP endpoint pipes per-match SSE events so the client can render
// incrementally and cancel mid-flight by closing the EventSource.
//
// Why ripgrep (with grep fallback): rg is ~10× faster than grep, respects
// .gitignore by default, has stable JSON output, and ships with a single
// binary on every platform. grep is the universal fallback for
// constrained Linux servers without rg installed; on Windows we don't
// fall back to findstr (different output format, no recursion semantics
// we can rely on) — instead the API returns 503 so the client can surface
// "ripgrep not installed" rather than silently misbehave.

'use strict';

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

// One-time async-safe detection of available search backends.
let _detectedBackend = null;
let _detectionDone = false;

function _detectBackend() {
  if (_detectionDone) return _detectedBackend;
  _detectionDone = true;

  const rgName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const which = process.platform === 'win32' ? 'where' : 'which';

  // Try rg first
  try {
    execFileSync(which, [rgName], { stdio: 'ignore', shell: false });
    _detectedBackend = 'rg';
    return _detectedBackend;
  } catch (_) { /* not found */ }

  // Linux/macOS only: fall back to grep
  if (process.platform !== 'win32') {
    try {
      execFileSync(which, ['grep'], { stdio: 'ignore', shell: false });
      _detectedBackend = 'grep';
      return _detectedBackend;
    } catch (_) { /* not found */ }
  }

  _detectedBackend = null;
  return _detectedBackend;
}

/**
 * Re-run backend detection. Useful in tests or after install.
 */
function resetBackendDetection() {
  _detectedBackend = null;
  _detectionDone = false;
}

/**
 * Synchronous accessor — returns 'rg' | 'grep' | null.
 */
function detectBackend() { return _detectBackend(); }

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
  ];
  if (!opts.caseSensitive) args.push('--ignore-case');
  if (!opts.regex) args.push('--fixed-strings');
  if (opts.glob) args.push('--glob', opts.glob);
  // -- separates options from positional args (paranoia: rg also has
  // --regexp= which we use, but extra defence is cheap).
  args.push('--regexp', query);
  args.push('--', opts.cwd || '.');
  return { cmd: 'rg', args };
}

/**
 * Build the grep argv (Linux fallback).
 *
 * grep doesn't ship with structured output — we emit `path:line:text`
 * via -n and parse on the consumer side.
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
  const args = ['-RIn', '--color=never'];
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
  args.push(opts.cwd || '.');
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
 *   - onEnd:         ({ matches: int, truncated: boolean, backend }) => void
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
      onEnd({ matches: 0, truncated: false, backend: null });
    });
    return { kill() {}, backend: null };
  }

  const { cmd, args } = backend === 'rg'
    ? _buildRgArgs(query, opts)
    : _buildGrepArgs(query, opts);

  const child = spawn(cmd, args, {
    cwd: opts.cwd || process.cwd(),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let matches = 0;
  let truncated = false;
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
  let stdoutBuf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    if (killed) return;
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
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
          // grep: <path>:<lineNumber>:<text>
          // Path can contain ':' so split with limit-2 from the LEFT,
          // but we don't know how many ':' are in the path. Use the
          // first two ':' that surround a numeric run.
          const m = line.match(/^([^\n]+?):(\d+):(.*)$/);
          if (m) {
            matches += 1;
            onMatch({
              path: m[1],
              line: parseInt(m[2], 10),
              col: 1,                  // grep doesn't give us a col
              text: m[3],
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
  });

  child.stderr.setEncoding('utf8');
  let stderrBuf = '';
  child.stderr.on('data', (chunk) => { stderrBuf += chunk; if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096); });

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
    onEnd({ matches: matches, truncated: truncated, backend: backend });
  });

  return { kill: killChild, backend: backend };
}

module.exports = {
  searchStream: searchStream,
  detectBackend: detectBackend,
  resetBackendDetection: resetBackendDetection,
};
