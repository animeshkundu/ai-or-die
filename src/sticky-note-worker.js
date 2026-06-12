'use strict';

// Worker thread that runs the local LLM (node-llama-cpp) for sticky-note
// summaries. Mirrors src/stt-worker.js: load the model once, then answer
// {type:'infer'} messages. node-llama-cpp is ESM-only, so it is pulled in via
// dynamic import(); a missing module is reported as {type:'error'} and the
// worker exits (the engine then degrades gracefully to "unavailable").

const { parentPort, workerData } = require('worker_threads');
const os = require('os');
const { SYSTEM_PROMPT, NOTE_SCHEMA } = require('./sticky-note-prompt');

const modelPath = workerData.modelPath;
const contextSize = workerData.contextSize || 8192;
const numThreads = workerData.numThreads || Math.max(1, Math.min(4, os.cpus().length - 2));
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
  model = await llama.loadModel({ modelPath });
  context = await model.createContext({ contextSize, threads: numThreads });
  sequence = context.getSequence();
  grammar = await llama.createGrammarForJsonSchema(NOTE_SCHEMA);

  parentPort.postMessage({ type: 'ready' });
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
        try { if (context) await context.dispose(); } catch { /* ignore */ }
        try { if (model) await model.dispose(); } catch { /* ignore */ }
      })
      .finally(() => process.exit(0));
  }
});

init().catch((err) => {
  parentPort.postMessage({ type: 'error', message: (err && err.message) || 'init failed' });
  process.exit(1);
});
