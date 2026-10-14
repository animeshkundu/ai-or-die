'use strict';

// File logging for the user-level service.
//
// The Task Scheduler / launchd / systemd units cannot rely on shell
// redirection (direct-Exec has none; launchd discards stdio), and the CLI
// `service logs` command reads SUPERVISOR_LOG_FILE — which nothing wrote
// until now. This module tees console output to that file (append-only,
// never rename-while-open: Windows holds an exclusive append handle, so
// rotation is copy-truncate). Best-effort and never throws into the caller.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = parseInt(process.env.AIORDIE_LOG_MAX_BYTES, 10) || 10 * 1024 * 1024;
const KEEP_BYTES = parseInt(process.env.AIORDIE_LOG_KEEP_BYTES, 10) || 5 * 1024 * 1024;

let _installed = false;
let _stream = null;
let _logFile = null;
let _streamError = null;
let _originals = null;
let _timer = null;

function logFilePath() {
  try {
    return require('./constants').SUPERVISOR_LOG_FILE;
  } catch (_) {
    return null;
  }
}

// Truncate the log to its last KEEP_BYTES (copy-truncate: safe while the
// append handle is open). Runs at startup and hourly; best-effort.
function maybeRotate(logFile) {
  try {
    const st = fs.statSync(logFile);
    if (!st || st.size < MAX_BYTES) return;
    const fd = fs.openSync(logFile, 'r');
    try {
      const start = Math.max(0, st.size - KEEP_BYTES);
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const wfd = fs.openSync(logFile, 'w');
      try {
        fs.writeSync(wfd, `...[rotated ${new Date().toISOString()}]...\n`);
        fs.writeSync(wfd, buf);
      } finally {
        fs.closeSync(wfd);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) { /* best-effort */ }
}

function setupFileLogging(options = {}) {
  if (_installed) return { active: !!_stream, logFile: _logFile };
  _installed = true;
  const logFile = options.logFile || logFilePath();
  if (!logFile) return { active: false, logFile: null };
  _logFile = logFile;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    maybeRotate(logFile);
    _stream = fs.createWriteStream(logFile, { flags: 'a' });
    _streamError = null;
    _stream.on('error', (err) => { _streamError = err; });
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    _originals = {};
    for (const m of methods) {
      _originals[m] = console[m];
      const orig = console[m] && console[m].bind(console);
      console[m] = (...args) => {
        try { if (orig) orig(...args); } catch (_) {}
        try {
          if (_stream && !_stream.destroyed) {
            _stream.write(`[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`);
          }
        } catch (_) {}
      };
    }
    const timer = setInterval(() => maybeRotate(logFile), 3600000);
    if (timer.unref) timer.unref();
    _timer = timer;
    return { active: true, logFile };
  } catch (_) {
    _stream = null;
    return { active: false, logFile };
  }
}

// True while the append stream is usable. Lets `service status` distinguish
// "logging" from "stream failed (ENOSPC/EACCES)".
function isHealthy() {
  try {
    return !!(_installed && _stream && !_stream.destroyed && !_streamError);
  } catch (_) {
    return false;
  }
}

// Restore original console methods and close the stream. Used by tests to
// avoid cross-test console pollution; also callable on shutdown.
function teardown() {
  try {
    if (_timer) clearInterval(_timer);
  } catch (_) {}
  _timer = null;
  try {
    if (_originals) {
      for (const m of Object.keys(_originals)) console[m] = _originals[m];
    }
  } catch (_) {}
  _originals = null;
  try {
    if (_stream) _stream.end();
  } catch (_) {}
  _stream = null;
  _streamError = null;
  _installed = false;
  _logFile = null;
}

module.exports = { setupFileLogging, maybeRotate, teardown, isHealthy, MAX_BYTES, KEEP_BYTES };
