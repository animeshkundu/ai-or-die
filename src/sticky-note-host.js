#!/usr/bin/env node

'use strict';

const os = require('os');
const { SYSTEM_PROMPT, NOTE_SCHEMA } = require('./sticky-note-prompt');
const { pickThreads } = require('./sticky-note-threads');
const { startModelHostRuntime } = require('./model-host-runtime');

const data = JSON.parse(Buffer.from(process.env.AI_OR_DIE_MODEL_HOST_DATA || '', 'base64').toString('utf8') || '{}');
let llama;
let model;
let context;
let sequence;
let grammar;
let LlamaChatSessionCtor;

startModelHostRuntime({
  async load() {
    let nlc;
    try {
      nlc = await import('node-llama-cpp');
    } catch (error) {
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    const { getLlama, LlamaChatSession } = nlc;
    LlamaChatSessionCtor = LlamaChatSession;
    llama = await getLlama();
    const cpus = (typeof os.availableParallelism === 'function'
      ? os.availableParallelism()
      : 0) || os.cpus().length;
    const gpu = !!llama.gpu;
    const threads = pickThreads({ explicit: data.numThreads, gpu, cpus });
    if (gpu) {
      try {
        model = await llama.loadModel({ modelPath: data.modelPath, gpuLayers: 'max' });
      } catch (_) {
        model = await llama.loadModel({ modelPath: data.modelPath });
      }
    } else {
      model = await llama.loadModel({ modelPath: data.modelPath });
    }
    context = await model.createContext({ contextSize: data.contextSize || 8192, threads });
    sequence = context.getSequence();
    grammar = await llama.createGrammarForJsonSchema(NOTE_SCHEMA);
    return { addonLoaded: 'node-llama-cpp', gpu, threads };
  },

  async request(meta, payload) {
    let session;
    try {
      session = new LlamaChatSessionCtor({
        contextSequence: sequence,
        systemPrompt: SYSTEM_PROMPT,
      });
      const text = await session.prompt(payload.toString('utf8'), {
        grammar,
        maxTokens: data.maxTokens || 320,
        temperature: 0,
      });
      return { text };
    } finally {
      if (session) {
        try { session.dispose(); } catch (_) {}
      }
    }
  },

  async shutdown() {
    try { if (context) await context.dispose(); } catch (_) {}
    try { if (model) await model.dispose(); } catch (_) {}
    try { if (llama) await llama.dispose(); } catch (_) {}
    context = null;
    model = null;
    llama = null;
  },
});
