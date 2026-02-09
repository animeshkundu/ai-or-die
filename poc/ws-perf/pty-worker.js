'use strict';

/**
 * Worker thread that owns a single PTY process.
 * Communicates with the main thread via parentPort messages.
 *
 * Messages IN:  { type: 'input', data } | { type: 'resize', cols, rows } | { type: 'kill' }
 * Messages OUT: { type: 'data', data }  | { type: 'exit', code, signal }
 */

const { parentPort, workerData } = require('worker_threads');
const { spawn } = require('@lydell/node-pty');

const { shell, args, ptyOpts } = workerData;

const ptyProcess = spawn(shell, args || [], {
  cwd: ptyOpts.cwd || '.',
  env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1', COLORTERM: 'truecolor' },
  cols: ptyOpts.cols || 120,
  rows: ptyOpts.rows || 40,
  name: ptyOpts.name || 'xterm-256color'
});

// Batch output using setImmediate (same pattern as base-bridge.js)
let outputBatch = '';
let flushTimer = null;

ptyProcess.onData((data) => {
  outputBatch += data;
  if (!flushTimer) {
    flushTimer = setImmediate(() => {
      parentPort.postMessage({ type: 'data', data: outputBatch });
      outputBatch = '';
      flushTimer = null;
    });
  }
});

ptyProcess.onExit((code, signal) => {
  parentPort.postMessage({ type: 'exit', code, signal });
});

parentPort.on('message', (msg) => {
  switch (msg.type) {
    case 'input':
      ptyProcess.write(msg.data);
      break;
    case 'resize':
      ptyProcess.resize(msg.cols, msg.rows);
      break;
    case 'kill':
      ptyProcess.kill();
      break;
  }
});
