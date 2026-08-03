#!/usr/bin/env node

'use strict';

const path = require('path');
const os = require('os');
const { pcm16ToFloat32 } = require('./utils/pcm');
const { startModelHostRuntime } = require('./model-host-runtime');

const data = JSON.parse(Buffer.from(process.env.AI_OR_DIE_MODEL_HOST_DATA || '', 'base64').toString('utf8') || '{}');
const nodeModulesDir = data.nodeModulesDir || path.resolve(__dirname, '..', 'node_modules');
const platform = os.platform() === 'win32' ? 'win' : os.platform();
const nativeDir = path.join(nodeModulesDir, `sherpa-onnx-${platform}-${os.arch()}`);

if (os.platform() === 'win32') {
  process.env.PATH = nativeDir + path.delimiter + (process.env.PATH || '');
} else if (os.platform() === 'linux') {
  process.env.LD_LIBRARY_PATH = nativeDir + path.delimiter + (process.env.LD_LIBRARY_PATH || '');
} else if (os.platform() === 'darwin') {
  process.env.DYLD_LIBRARY_PATH = nativeDir + path.delimiter + (process.env.DYLD_LIBRARY_PATH || '');
}

let recognizer;

startModelHostRuntime({
  load() {
    let OfflineRecognizer;
    try {
      ({ OfflineRecognizer } = require('sherpa-onnx-node'));
    } catch (error) {
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    recognizer = new OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: path.join(data.modelDir, 'encoder.int8.onnx'),
          decoder: path.join(data.modelDir, 'decoder.int8.onnx'),
          joiner: path.join(data.modelDir, 'joiner.int8.onnx'),
        },
        tokens: path.join(data.modelDir, 'tokens.txt'),
        numThreads: data.numThreads || Math.min(4, os.cpus().length),
        provider: 'cpu',
        debug: 0,
      },
    });
    return { addonLoaded: 'sherpa-onnx-node' };
  },

  request(meta, payload) {
    const samples = meta.dtype === 'pcm16'
      ? pcm16ToFloat32(new Int16Array(payload.buffer, payload.byteOffset, payload.byteLength / 2))
      : new Float32Array(payload.buffer, payload.byteOffset, payload.byteLength / 4);
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: 16000 });
    recognizer.decode(stream);
    const result = recognizer.getResult(stream);
    return { text: (result.text || '').trim() };
  },

  shutdown() {
    recognizer = null;
  },
});
