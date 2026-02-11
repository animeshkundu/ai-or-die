'use strict';

const { parentPort, workerData } = require('worker_threads');
const path = require('path');
const os = require('os');

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
const { OfflineRecognizer } = require('sherpa-onnx-node');

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

parentPort.on('message', (msg) => {
  if (msg.type === 'transcribe') {
    try {
      // msg.samples is a Float32Array (transferred or copied from main thread)
      const samples = msg.samples instanceof Float32Array
        ? msg.samples
        : new Float32Array(msg.samples);

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
