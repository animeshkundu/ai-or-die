'use strict';

// End-to-end regression for the Ctrl+C native-worker SIGABRT.
//
// Bug: starting the app and pressing Ctrl+C aborted the process with SIGABRT
// (signal 6 / shell exit 134) printing "libc++abi: terminating due to uncaught
// exception of type Napi::Error". The two ggml-based native worker engines (STT
// = sherpa-onnx, sticky-note = node-llama-cpp) were force-torn-down by
// process.exit() while a model was loaded/loading; ggml's process-wide
// set_terminate handler turned the uncaught Napi error into SIGABRT.
//
// This test starts the REAL server with both engines enabled, sends a
// process-group SIGINT (a real terminal Ctrl+C) during the startup window, and
// asserts a clean exit (code 0, no terminating signal) with no native-abort
// markers in the output.
//
// The abort is only possible when the native models are actually LOADED, so the
// test auto-skips when the STT or sticky-note model is not present on disk (e.g.
// a clean CI checkout). The engine-level cooperative-shutdown behaviour is
// covered without models by test/sticky-note-engine.test.js and
// test/longevity/process/stt-worker-respawn.test.js.

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ENTRY = path.join(REPO_ROOT, 'bin', 'ai-or-die.js');
const PORT = 11929; // > 11000 per repo test-port policy
const ABORT_MARKERS = /libc\+\+abi|ggml_uncaught_exception|uncaught exception of type Napi::Error/;

async function modelsPresent() {
  try {
    const ModelManager = require(path.join(REPO_ROOT, 'src', 'utils', 'model-manager.js'));
    const GgufModelManager = require(path.join(REPO_ROOT, 'src', 'utils', 'gguf-model-manager'));
    const sttReady = await new ModelManager({}).isModelReady();
    const ggufReady = await new GgufModelManager({}).isModelReady();
    return sttReady && ggufReady;
  } catch (_) {
    return false;
  }
}

// Start the server, wait until it logs it is listening, sleep `settleMs` (to land
// in the model-load window), send SIGINT to the whole process group, and resolve
// with the exit code/signal and captured output.
function startThenSigint(settleMs) {
  return new Promise((resolve, reject) => {
    let out = '';
    let ready = false;
    let signalled = false;
    const child = spawn(process.execPath, [ENTRY, '--port', String(PORT)], {
      cwd: REPO_ROOT,
      detached: true, // own process group so SIGINT to -pid mimics a terminal Ctrl+C
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AOD_SUPERVISOR_RESTART: '1' }, // never auto-open a browser
    });

    const onData = (buf) => {
      out += buf.toString();
      if (!ready && /is running at|Press Ctrl\+C to stop/.test(out)) {
        ready = true;
        setTimeout(() => {
          signalled = true;
          try { process.kill(-child.pid, 'SIGINT'); } catch (_) { /* group may already be gone */ }
        }, settleMs);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const readyTimer = setTimeout(() => {
      if (!ready) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* ignore */ }
        reject(new Error('server did not start within 40s'));
      }
    }, 40000);

    const killTimer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* ignore */ }
    }, 55000);

    child.on('exit', (code, signal) => {
      clearTimeout(readyTimer);
      clearTimeout(killTimer);
      resolve({ code, signal, out, ready, signalled });
    });
    child.on('error', reject);
  });
}

describe('Ctrl+C native-worker shutdown (e2e)', function () {
  this.timeout(70000);

  before(async function () {
    // POSIX-only: this drives a real terminal Ctrl+C via a process-group SIGINT
    // (`process.kill(-pid, 'SIGINT')` on a detached child). Windows has no POSIX
    // process groups / SIGINT delivery, so that mechanism is a no-op there and the
    // child never receives the signal (the test would hang to its timeout). The
    // Windows shutdown path is IPC-driven and is covered end-to-end by
    // server-shutdown-e2e.test.js ("graceful shutdown exits cleanly").
    if (process.platform === 'win32') {
      this.skip();
    }
    if (!(await modelsPresent())) {
      this.skip(); // models not downloaded — the native abort cannot occur
    }
  });

  // Sweep the startup window (the abort used to fire when Ctrl+C raced the
  // synchronous model load). Each case must exit cleanly.
  for (const settleMs of [500, 1500, 2500]) {
    it(`exits 0 with no native abort when Ctrl+C arrives ${settleMs}ms after start`, async function () {
      const r = await startThenSigint(settleMs);
      assert.strictEqual(r.ready, true, 'server should have started');
      assert.strictEqual(r.signalled, true, 'SIGINT should have been sent');
      assert.ok(
        !ABORT_MARKERS.test(r.out),
        `native abort marker found in output (regression):\n${r.out.slice(-600)}`
      );
      assert.strictEqual(
        r.signal, null,
        `process must not die from a signal (got ${r.signal}); SIGABRT here = the regression`
      );
      assert.strictEqual(r.code, 0, `expected clean exit 0, got code ${r.code}`);
    });
  }
});
