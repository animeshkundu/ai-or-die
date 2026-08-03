#!/usr/bin/env node

'use strict';

const { startModelHostRuntime } = require('../../src/model-host-runtime');

const data = JSON.parse(Buffer.from(process.env.AI_OR_DIE_MODEL_HOST_DATA || '', 'base64').toString('utf8') || '{}');

if (data.exitImmediately) process.exit(23);

startModelHostRuntime({
  async load() {
    if (data.loadDelayMs) await new Promise((resolve) => setTimeout(resolve, data.loadDelayMs));
    if (data.failCode) {
      const error = new Error(data.failMessage || 'fixture load failed');
      error.code = data.failCode;
      throw error;
    }
    return {
      addonLoaded: 'fixture-native',
      inheritedCredential: process.env.AIORDIE_TOKEN || null,
      backendConfig: process.env.CUDA_PATH || null,
    };
  },
  async request(meta, payload) {
    if (data.requestDelayMs) await new Promise((resolve) => setTimeout(resolve, data.requestDelayMs));
    return { text: payload.toString(meta.dtype === 'utf8' ? 'utf8' : 'hex') };
  },
  async shutdown() {
    if (data.shutdownDelayMs) await new Promise((resolve) => setTimeout(resolve, data.shutdownDelayMs));
  },
});
