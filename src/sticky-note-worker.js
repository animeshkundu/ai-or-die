'use strict';

// Worker thread that runs the local LLM (node-llama-cpp) for sticky-note
// summaries. Mirrors src/stt-worker.js: load the model once, then answer
// {type:'infer'} messages. node-llama-cpp is ESM-only, so it is pulled in via
// dynamic import(); a missing module is reported as {type:'error'} and the
// worker exits (the engine then degrades gracefully to "unavailable").

const { parentPort, workerData } = require('worker_threads');
const os = require('os');
const { SYSTEM_PROMPT, NOTE_SCHEMA } = require('./sticky-note-prompt');
const { pickThreads } = require('./sticky-note-threads');

const modelPath = workerData.modelPath;
const contextSize = workerData.contextSize || 8192;
const maxTokens = workerData.maxTokens || 320;

let llama;
let model;
let context;
let sequence;
let grammar;
let LlamaChatSessionCtor;

async function init() {
  let nlc;
  try {
    nlc = await import('node-llama-cpp');
  } catch (err) {
    parentPort.postMessage({
      type: 'error',
      code: 'MODULE_NOT_FOUND',
      message:
        'node-llama-cpp is not installed. Install it with: npm install node-llama-cpp\n' +
        `(Original error: ${err && err.message})`,
    });
    process.exit(1);
    return;
  }

  const { getLlama, LlamaChatSession } = nlc;
  LlamaChatSessionCtor = LlamaChatSession;

  llama = await getLlama();
  // availableParallelism() reflects usable parallelism better than cpus().length
  // on Windows hybrid P/E-core machines; fall back where it's unavailable.
  const cpus = (typeof os.availableParallelism === 'function' ? os.availableParallelism() : 0) || os.cpus().length;
  // llama.gpu is false | 'cuda' | 'vulkan' | 'metal'; any non-empty string = GPU.
  const gpu = !!llama.gpu;
  const numThreads = pickThreads({ explicit: workerData.numThreads, gpu, cpus });
  // Use the GPU fully when present: request all layers in VRAM ('max'). If the
  // GPU can't fit them, 'max' throws — fall back to the default 'auto', which
  // still offloads as many layers as fit (never worse than CPU-only).
  if (gpu) {
    try {
      model = await llama.loadModel({ modelPath, gpuLayers: 'max' });
    } catch {
      model = await llama.loadModel({ modelPath });
    }
  } else {
    model = await llama.loadModel({ modelPath });
  }
  context = await model.createContext({ contextSize, threads: numThreads });
  sequence = context.getSequence();
  grammar = await llama.createGrammarForJsonSchema(NOTE_SCHEMA);

  parentPort.postMessage({ type: 'ready', gpu, threads: numThreads });
}

async function handleInfer(msg) {
  let session;
  try {
    // Fresh chat session per request on the shared sequence -> no cross-tab
    // history bleed.
    session = new LlamaChatSessionCtor({ contextSequence: sequence, systemPrompt: SYSTEM_PROMPT });
    const text = await session.prompt(msg.prompt, { grammar, maxTokens, temperature: 0 });
    parentPort.postMessage({ type: 'result', id: msg.id, text });
  } catch (err) {
    parentPort.postMessage({ type: 'result', id: msg.id, error: (err && err.message) || 'inference failed' });
  } finally {
    try {
      if (session) session.dispose();
    } catch {
      /* ignore */
    }
  }
}

// Serialize inference: the shared context sequence must NEVER have two
// session.prompt() calls in flight at once (corrupts KV state / crashes the
// native layer). The engine already serialises, but its timeout path can post
// a new request before the worker finishes the previous one — so we queue here
// and run strictly one-at-a-time regardless.
let _inferChain = Promise.resolve();
let _shuttingDown = false;
parentPort.on('message', (msg) => {
  if (!msg) return;
  if (msg.type === 'infer') {
    if (_shuttingDown) return;
    _inferChain = _inferChain.then(() => handleInfer(msg));
  } else if (msg.type === 'shutdown') {
    // Graceful teardown: finish any in-flight inference, then dispose the
    // native model/context BEFORE the thread is killed. Abruptly terminating
    // the worker with a loaded GGUF can abort the process (Napi cleanup) and,
    // on Windows, leave a file lock on the model.
    _shuttingDown = true;
    _inferChain
      .catch(() => {})
      .then(async () => {
        // Dispose in dependency order: context + model, then the top-level
        // llama backend. Disposing the backend (await llama.dispose()) is what
        // actually drains node-llama-cpp's native async work; without it the
        // worker-thread env teardown that follows process.exit() can hit a
        // pending Napi completion and ggml's set_terminate aborts the whole
        // process (SIGABRT / exit 134) on Ctrl+C.
        try { if (context) await context.dispose(); } catch { /* ignore */ }
        try { if (model) await model.dispose(); } catch { /* ignore */ }
        try { if (llama) await llama.dispose(); } catch { /* ignore */ }
      })
      .finally(() => process.exit(0));
  }
});

init().catch((err) => {
  parentPort.postMessage({ type: 'error', message: (err && err.message) || 'init failed' });
  process.exit(1);
});
