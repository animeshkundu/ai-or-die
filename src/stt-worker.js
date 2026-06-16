'use strict';

const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const os = require('os');
const { pcm16ToFloat32 } = require('./utils/pcm.js');

// Set platform-specific library paths BEFORE requiring sherpa-onnx-node.
// The native .node addon dynamically loads shared libraries (onnxruntime.dll,
// sherpa-onnx-c-api.dll, etc.) from the platform package directory. On Windows,
// System32 may contain a conflicting onnxruntime.dll so we must prepend our
// native dir to PATH. On Linux, LD_LIBRARY_PATH must include the native dir.
// macOS DYLD_LIBRARY_PATH may be stripped by SIP — noted but set anyway.
const platform = os.platform() === 'win32' ? 'win' : os.platform();
const arch = os.arch();
const nodeModulesDir = workerData.nodeModulesDir ||
  path.resolve(__dirname, '..', 'node_modules');
const nativeDir = path.join(nodeModulesDir, `sherpa-onnx-${platform}-${arch}`);

if (os.platform() === 'win32') {
  process.env.PATH = nativeDir + path.delimiter + (process.env.PATH || '');
} else if (os.platform() === 'linux') {
  process.env.LD_LIBRARY_PATH =
    nativeDir + path.delimiter + (process.env.LD_LIBRARY_PATH || '');
} else if (os.platform() === 'darwin') {
  // SIP may strip DYLD_LIBRARY_PATH for child processes, but set it anyway
  // in case we are not running under SIP restrictions (e.g. unsigned binaries).
  process.env.DYLD_LIBRARY_PATH =
    nativeDir + path.delimiter + (process.env.DYLD_LIBRARY_PATH || '');
}

// Now safe to require sherpa-onnx-node
let OfflineRecognizer;
try {
  ({ OfflineRecognizer } = require('sherpa-onnx-node'));
} catch (err) {
  parentPort.postMessage({
    type: 'error',
    message: `sherpa-onnx-node is not installed. Install it with: npm install sherpa-onnx-node\n(Original error: ${err.message})`
  });
  process.exit(1);
}

const modelDir = workerData.modelDir;
const numThreads = workerData.numThreads || Math.min(4, os.cpus().length);

let recognizer;

try {
  const config = {
    featConfig: {
      sampleRate: 16000,
      featureDim: 80
    },
    modelConfig: {
      transducer: {
        encoder: path.join(modelDir, 'encoder.int8.onnx'),
        decoder: path.join(modelDir, 'decoder.int8.onnx'),
        joiner: path.join(modelDir, 'joiner.int8.onnx')
      },
      tokens: path.join(modelDir, 'tokens.txt'),
      numThreads,
      provider: 'cpu',
      debug: 0
    }
  };

  recognizer = new OfflineRecognizer(config);
  parentPort.postMessage({ type: 'ready' });
} catch (err) {
  parentPort.postMessage({ type: 'error', message: err.message });
  process.exit(1);
}

let _shuttingDown = false;
parentPort.on('message', (msg) => {
  if (!msg) return;
  if (msg.type === 'shutdown') {
    // Graceful teardown. sherpa-onnx-node exposes no dispose API (the recognizer
    // is GC/finalizer-managed), and transcribe runs synchronously here, so when
    // this message is processed nothing is in flight. Exit cleanly while idle so
    // the worker-env teardown doesn't race a pending native op — a bare
    // terminate() with the recognizer loaded can abort the process during native
    // cleanup (SIGABRT / exit 134) on Ctrl+C.
    _shuttingDown = true;
    process.exit(0);
    return;
  }
  if (msg.type === 'transcribe') {
    if (_shuttingDown) return;
    try {
      // Two input shapes:
      //  - msg.pcm16: raw 16-bit PCM (Int16Array). Conversion to Float32 runs
      //    HERE, in the worker thread, so the server event loop never does the
      //    per-sample loop (HOL-blocking input/ping for long clips).
      //  - msg.samples: a Float32Array (legacy / external-endpoint callers).
      let samples;
      if (msg.pcm16 !== undefined && msg.pcm16 !== null) {
        const int16 = msg.pcm16 instanceof Int16Array
          ? msg.pcm16
          : new Int16Array(msg.pcm16);
        samples = pcm16ToFloat32(int16);
      } else {
        samples = msg.samples instanceof Float32Array
          ? msg.samples
          : new Float32Array(msg.samples);
      }

      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: 16000 });
      recognizer.decode(stream);
      const result = recognizer.getResult(stream);

      parentPort.postMessage({
        type: 'result',
        id: msg.id,
        text: (result.text || '').trim()
      });
    } catch (err) {
      parentPort.postMessage({
        type: 'result',
        id: msg.id,
        error: err.message
      });
    }
  }
});
