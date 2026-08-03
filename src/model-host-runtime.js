'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { DTYPES, MAX_PAYLOAD_BYTES, FrameParser } = require('./model-host-protocol');

const MAX_PENDING_PARTS = 64;

function send(message) {
  if (process.connected && process.send) process.send(message);
}

function failProtocol(message) {
  send({ type: 'protocol_error', message });
  process.exitCode = 1;
  if (process.connected) {
    try { process.disconnect(); } catch (_) {}
  } else {
    process.exit(1);
  }
}

function startModelHostRuntime(handlers) {
  const metadata = new Map();
  const frames = new Map();
  const parser = new FrameParser();
  let loaded = false;
  let ready = false;
  let shuttingDown = false;
  let chain = Promise.resolve();
  let orphanTimer = null;
  let expectedNonce = null;
  let highestMetadataSeq = 0;
  let highestFrameSeq = 0;

  const keyOf = (nonce, seq) => `${nonce}:${seq}`;
  const expireOrphans = () => {
    const cutoff = Date.now() - 30000;
    let expired = false;
    for (const [key, value] of metadata) {
      if (value.at < cutoff) {
        metadata.delete(key);
        expired = true;
      }
    }
    for (const [key, value] of frames) {
      if (value.at < cutoff) {
        frames.delete(key);
        expired = true;
      }
    }
    if (expired) {
      failProtocol('Orphan model-host metadata/frame expired');
    }
  };
  const maybeDispatch = (key) => {
    const meta = metadata.get(key);
    const framed = frames.get(key);
    if (!meta || !framed) return;
    metadata.delete(key);
    frames.delete(key);
    if (meta.dtype !== framed.dtype || meta.length !== framed.length) {
      failProtocol('Control metadata does not match binary frame');
      return;
    }
    chain = chain.then(async () => {
      if (shuttingDown) return;
      try {
        const result = await handlers.request(meta, framed.payload);
        send({ ...(result || {}), type: 'result', nonce: meta.nonce, seq: meta.seq });
      } catch (error) {
        send({
          type: 'result',
          nonce: meta.nonce,
          seq: meta.seq,
          error: (error && error.message) || 'model-host request failed',
        });
      }
    });
  };

  parser.on('frame', (frame) => {
    const key = keyOf(frame.nonce, frame.seq);
    if (expectedNonce !== null && frame.nonce !== expectedNonce) {
      failProtocol('Binary frame generation nonce mismatch');
      return;
    }
    if (frame.seq <= highestFrameSeq || frames.has(key)) {
      failProtocol('Duplicate binary frame id');
      return;
    }
    expectedNonce = frame.nonce;
    highestFrameSeq = frame.seq;
    if (frames.size >= MAX_PENDING_PARTS) {
      failProtocol('Too many pending model-host binary frames');
      return;
    }
    frames.set(key, { ...frame, at: Date.now() });
    maybeDispatch(key);
  });
  parser.on('protocolError', (error) => {
    failProtocol(error.message);
  });
  const payload = fs.createReadStream(null, { fd: 4, autoClose: false });
  payload.on('data', (chunk) => parser.push(chunk));
  payload.on('end', () => parser.end());
  payload.on('error', (error) => parser.emit('protocolError', error));

  const watchdog = new Worker(path.join(__dirname, 'model-host-liveness.js'), {
    workerData: { fd: 5 },
  });
  watchdog.on('message', (message) => {
    if (message && message.type === 'armed') {
      send({ type: 'liveness_armed' });
    } else if (message && message.type === 'failed') {
      send({ type: 'error', code: 'LIVENESS_FAILED', message: message.message });
      process.exit(1);
    }
  });
  watchdog.once('error', (error) => {
    send({ type: 'error', code: 'LIVENESS_FAILED', message: error.message });
    process.exit(1);
  });
  watchdog.once('exit', (code) => {
    if (!shuttingDown) {
      send({ type: 'error', code: 'LIVENESS_FAILED', message: `liveness watchdog exited (${code})` });
      process.exit(1);
    }
  });

  orphanTimer = setInterval(expireOrphans, 5000);
  if (orphanTimer.unref) orphanTimer.unref();

  process.on('message', (message) => {
    if (!message) return;
    if (message.type === 'load' && !loaded) {
      loaded = true;
      Promise.resolve()
        .then(() => handlers.load())
        .then((info) => {
          ready = true;
          send({ ...(info || {}), type: 'ready' });
        })
        .catch((error) => {
          send({
            type: 'error',
            code: error && error.code,
            message: (error && error.message) || 'model-host load failed',
          });
          process.exit(1);
        });
      return;
    }
    if (message.type === 'request') {
      if (!ready) {
        failProtocol('Model-host request received before ready');
        return;
      }
      if (!Number.isSafeInteger(message.nonce) || message.nonce < 1 || message.nonce > 0xffffffff ||
          !Number.isSafeInteger(message.seq) || message.seq < 1 || message.seq > 0xffffffff ||
          !Object.prototype.hasOwnProperty.call(DTYPES, message.dtype) ||
          !Number.isSafeInteger(message.length) || message.length < 0 ||
          message.length > MAX_PAYLOAD_BYTES) {
        failProtocol('Invalid model-host control metadata');
        return;
      }
      const key = keyOf(message.nonce, message.seq);
      if (expectedNonce !== null && message.nonce !== expectedNonce) {
        failProtocol('Control metadata generation nonce mismatch');
        return;
      }
      if (message.seq <= highestMetadataSeq || metadata.has(key)) {
        failProtocol('Duplicate control metadata id');
        return;
      }
      expectedNonce = message.nonce;
      highestMetadataSeq = message.seq;
      if (metadata.size >= MAX_PENDING_PARTS) {
        failProtocol('Too many pending model-host control messages');
        return;
      }
      metadata.set(key, { ...message, at: Date.now() });
      maybeDispatch(key);
      return;
    }
    if (message.type === 'shutdown' && !shuttingDown) {
      shuttingDown = true;
      clearInterval(orphanTimer);
      chain
        .catch(() => {})
        .then(() => handlers.shutdown ? handlers.shutdown() : undefined)
        .finally(() => {
          try { process.kill(process.pid, 'SIGKILL'); } catch (_) { process.exit(0); }
        });
    }
  });

  process.on('disconnect', () => process.exit(process.exitCode || 0));
}

module.exports = { startModelHostRuntime };
