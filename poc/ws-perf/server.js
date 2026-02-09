'use strict';

/**
 * Configurable WebSocket + PTY server for benchmarking I/O optimizations.
 *
 * Feature flags (pass as comma-separated --flags):
 *   A  TCP_NODELAY         — socket.setNoDelay(true)
 *   B  Circular Buffer     — O(1) output buffer vs array.shift()
 *   C  Input Priority      — process.nextTick for input messages
 *   D  Binary Output       — raw binary WebSocket frames for terminal output
 *   E  Plan Detector Opt   — trigger-scan instead of full-buffer regex
 *   F  Worker Threads      — PTY in worker_threads (separate event loop)
 *
 * Usage:
 *   node server.js --port 7777 --flags A,B,C
 *   node server.js --flags ALL
 *   node server.js                      # baseline (no optimizations)
 */

const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('@lydell/node-pty');
const os = require('os');
const path = require('path');
const CircularBuffer = require('./circular-buffer');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { port: 7777, flags: new Set() };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      opts.port = parseInt(args[++i], 10);
    } else if (args[i] === '--flags' && args[i + 1]) {
      const raw = args[++i];
      if (raw.toUpperCase() === 'ALL') {
        'ABCDE'.split('').forEach(f => opts.flags.add(f));
        // F (workers) added only if explicitly included
      } else if (raw.toUpperCase() === 'ALLF') {
        'ABCDEF'.split('').forEach(f => opts.flags.add(f));
      } else {
        raw.split(',').forEach(f => opts.flags.add(f.trim().toUpperCase()));
      }
    }
  }
  return opts;
}

const config = parseArgs();
const FLAGS = config.flags;
const PORT = config.port;

const has = (flag) => FLAGS.has(flag);

// ---------------------------------------------------------------------------
// Output buffer (B: circular vs array)
// ---------------------------------------------------------------------------

const OUTPUT_BUFFER_CAP = 1000;
const MAX_COALESCE_BYTES = 32 * 1024;
const COALESCE_MS = 16;

function makeOutputBuffer() {
  return has('B')
    ? new CircularBuffer(OUTPUT_BUFFER_CAP)
    : [];
}

function pushOutputBuffer(buf, data) {
  if (has('B')) {
    buf.push(data);
  } else {
    buf.push(data);
    if (buf.length > OUTPUT_BUFFER_CAP) buf.shift();
  }
}

// ---------------------------------------------------------------------------
// Plan detector simulation (E: optimized vs naive)
// ---------------------------------------------------------------------------

class NaivePlanDetector {
  constructor() {
    this.buffer = [];
    this.maxSize = 10000;
    this.active = false;
  }

  processOutput(data) {
    this.buffer.push({ timestamp: Date.now(), data });
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(-this.maxSize / 2);
    }
    // Full-buffer scan every time (the bottleneck we're testing)
    const text = this.buffer.map(i => i.data).join('')
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\x1b\[[0-9]*[A-Za-z]/g, '');
    const recent = text.slice(-50000);

    if (!this.active) {
      const indicators = ['Plan mode', 'MUST NOT make any edits', 'ExitPlanMode', 'Starting plan mode'];
      if (indicators.some(ind => recent.includes(ind))) {
        this.active = true;
      }
    }
    if (this.active) {
      if (recent.includes('approved your plan') || recent.includes('Plan mode exited')) {
        this.active = false;
      }
    }
  }
}

class OptimizedPlanDetector {
  constructor() {
    this.buffer = [];
    this.maxSize = 10000;
    this.active = false;
    this.triggers = [
      'Plan mode', 'MUST NOT make any edits', 'ExitPlanMode',
      'Starting plan mode', 'Implementation Plan', '### ',
      'Plan:', 'Plan Overview', 'Proposed Solution',
      'approved your plan', 'start coding', 'Plan mode exited',
      'Exiting plan mode'
    ];
  }

  processOutput(data) {
    this.buffer.push({ timestamp: Date.now(), data });
    if (this.buffer.length > this.maxSize) {
      this.buffer = this.buffer.slice(-this.maxSize / 2);
    }

    // Quick trigger check on new chunk only
    const clean = data.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\[[0-9]*[A-Za-z]/g, '');
    if (!this.triggers.some(t => clean.includes(t))) return;

    // Full scan only when trigger found
    const text = this.buffer.map(i => i.data).join('')
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\x1b\[[0-9]*[A-Za-z]/g, '');
    const recent = text.slice(-50000);

    if (!this.active) {
      const indicators = ['Plan mode', 'MUST NOT make any edits', 'ExitPlanMode', 'Starting plan mode'];
      if (indicators.some(ind => recent.includes(ind))) {
        this.active = true;
      }
    }
    if (this.active) {
      if (recent.includes('approved your plan') || recent.includes('Plan mode exited')) {
        this.active = false;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Worker thread PTY (F)
// ---------------------------------------------------------------------------
let WorkerPTY;
if (has('F')) {
  const { Worker } = require('worker_threads');
  WorkerPTY = class {
    constructor() {
      this.worker = null;
      this.onData = null;
      this.onExit = null;
    }

    start(shell, args, ptyOpts) {
      this.worker = new Worker(path.join(__dirname, 'pty-worker.js'), {
        workerData: { shell, args, ptyOpts }
      });
      this.worker.on('message', (msg) => {
        if (msg.type === 'data' && this.onData) this.onData(msg.data);
        if (msg.type === 'exit' && this.onExit) this.onExit(msg.code, msg.signal);
      });
      this.worker.on('error', (err) => {
        console.error('Worker error:', err);
      });
    }

    write(data) {
      if (this.worker) this.worker.postMessage({ type: 'input', data });
    }

    resize(cols, rows) {
      if (this.worker) this.worker.postMessage({ type: 'resize', cols, rows });
    }

    kill() {
      if (this.worker) {
        this.worker.postMessage({ type: 'kill' });
        setTimeout(() => {
          if (this.worker) this.worker.terminate();
        }, 2000);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const sessions = new Map();
const wsConnections = new Map();
let nextWsId = 1;

// Server-side timing tracker for measuring processing overhead
const inputTimestamps = new Map(); // nonce → t_server_recv

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`ws-perf server (flags: ${[...FLAGS].join(',') || 'none'})`);
});

const wss = new WebSocket.Server({
  server,
  maxPayload: 8 * 1024 * 1024,
  perMessageDeflate: {
    threshold: 1024,
    serverNoContextTakeover: false,
    clientNoContextTakeover: true,
    serverMaxWindowBits: 13,
    clientMaxWindowBits: 13,
    zlibDeflateOptions: { level: 1 }
  }
});

wss.on('connection', (ws, req) => {
  const wsId = nextWsId++;

  // Flag A: TCP_NODELAY
  if (has('A')) {
    const rawSocket = req.socket;
    if (rawSocket && typeof rawSocket.setNoDelay === 'function') {
      rawSocket.setNoDelay(true);
    }
  }

  const wsInfo = { id: wsId, ws, sessionId: null };
  wsConnections.set(wsId, wsInfo);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (has('C') && data.type === 'input') {
        // Flag C: Input priority via nextTick
        process.nextTick(() => handleMessage(wsId, data));
      } else {
        handleMessage(wsId, data);
      }
    } catch (err) {
      // ignore parse errors
    }
  });

  ws.on('close', () => {
    const info = wsConnections.get(wsId);
    if (info && info.sessionId) {
      const session = sessions.get(info.sessionId);
      if (session) session.connections.delete(wsId);
    }
    wsConnections.delete(wsId);
  });

  ws.send(JSON.stringify({ type: 'connected', wsId, flags: [...FLAGS] }));
});

function handleMessage(wsId, data) {
  const wsInfo = wsConnections.get(wsId);
  if (!wsInfo) return;

  switch (data.type) {
    case 'start_session': {
      const sessionId = data.sessionId || `s_${Date.now()}`;
      const shell = os.platform() === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
      const cols = data.cols || 120;
      const rows = data.rows || 40;

      const planDetector = has('E') ? new OptimizedPlanDetector() : new NaivePlanDetector();
      const outputBuffer = makeOutputBuffer();

      const session = {
        id: sessionId,
        process: null,
        connections: new Set(),
        outputBuffer,
        planDetector,
        _pendingOutput: '',
        _outputFlushTimer: null,
        active: true,
      };

      if (has('F') && WorkerPTY) {
        // Flag F: PTY in worker thread
        const workerPty = new WorkerPTY();
        workerPty.onData = (output) => onPtyOutput(sessionId, output);
        workerPty.onExit = (code, signal) => onPtyExit(sessionId, code, signal);
        workerPty.start(shell, [], {
          cwd: process.env.HOME || process.env.USERPROFILE || '.',
          cols, rows,
          name: 'xterm-256color'
        });
        session.process = workerPty;
      } else {
        // Direct PTY in main thread
        const ptyProcess = spawn(shell, [], {
          cwd: process.env.HOME || process.env.USERPROFILE || '.',
          env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1', COLORTERM: 'truecolor' },
          cols, rows,
          name: 'xterm-256color'
        });

        let outputBatch = '';
        let flushTimer = null;

        ptyProcess.onData((output) => {
          outputBatch += output;
          if (!flushTimer) {
            flushTimer = setImmediate(() => {
              onPtyOutput(sessionId, outputBatch);
              outputBatch = '';
              flushTimer = null;
            });
          }
        });

        ptyProcess.onExit((code, signal) => {
          onPtyExit(sessionId, code, signal);
        });

        session.process = ptyProcess;
      }

      sessions.set(sessionId, session);
      session.connections.add(wsId);
      wsInfo.sessionId = sessionId;
      wsInfo.ws.send(JSON.stringify({ type: 'session_started', sessionId }));
      break;
    }

    case 'input': {
      const session = sessions.get(wsInfo.sessionId);
      if (!session || !session.active) break;

      // Track server-side receive timestamp for markers
      const markerMatch = data.data && data.data.match(/__KP_(\w+)__/);
      if (markerMatch) {
        inputTimestamps.set(markerMatch[1], process.hrtime.bigint());
      }

      if (has('F') && session.process && session.process.write) {
        session.process.write(data.data);
      } else if (session.process && session.process.write) {
        session.process.write(data.data);
      }
      break;
    }

    case 'resize': {
      const session = sessions.get(wsInfo.sessionId);
      if (!session || !session.active) break;
      if (has('F') && session.process && session.process.resize) {
        session.process.resize(data.cols, data.rows);
      } else if (session.process && session.process.resize) {
        session.process.resize(data.cols, data.rows);
      }
      break;
    }

    case 'stop': {
      const session = sessions.get(wsInfo.sessionId);
      if (!session) break;
      if (has('F') && session.process && session.process.kill) {
        session.process.kill();
      } else if (session.process && session.process.kill) {
        session.process.kill();
      }
      break;
    }

    case 'start_flood': {
      // Synthetic heavy output generator — pumps ANSI-rich data through the
      // output pipeline (buffer, plan detector, throttle, broadcast) without
      // involving the PTY. The PTY remains free to process probe echo commands.
      const session = sessions.get(wsInfo.sessionId);
      if (!session) break;
      const durationMs = (data.duration || 10) * 1000;
      const intervalMs = data.interval || 50; // ms between bursts
      const linesPerBurst = data.lines || 30;

      let iteration = 0;
      const startTime = Date.now();
      session._floodInterval = setInterval(() => {
        if (Date.now() - startTime > durationMs) {
          clearInterval(session._floodInterval);
          session._floodInterval = null;
          return;
        }
        iteration++;
        let chunk = `\x1b[1m\x1b[34m## Phase ${(iteration % 5) + 1}: Implementation Details\x1b[0m\r\n`;
        for (let j = 1; j <= linesPerBurst; j++) {
          chunk += `\x1b[2m  Processing node ${iteration}.${j}: analyzing dependencies, resolving imports, checking types...\x1b[0m\r\n`;
        }
        chunk += `\x1b[1mPerformance metrics:\x1b[0m p50=\x1b[32m${Math.floor(Math.random() * 15 + 3)}ms\x1b[0m p95=\x1b[33m${Math.floor(Math.random() * 30 + 15)}ms\x1b[0m\r\n`;
        chunk += '\u2501'.repeat(78) + '\r\n';

        // Feed through the same output pipeline as real PTY output
        onPtyOutput(session.id, chunk);
      }, intervalMs);

      wsInfo.ws.send(JSON.stringify({ type: 'flood_started', duration: data.duration }));
      break;
    }

    case 'stop_flood': {
      const session = sessions.get(wsInfo.sessionId);
      if (session && session._floodInterval) {
        clearInterval(session._floodInterval);
        session._floodInterval = null;
      }
      break;
    }
  }
}

function onPtyOutput(sessionId, data) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Buffer for reconnection replay
  pushOutputBuffer(session.outputBuffer, data);

  // Plan detector processing
  session.planDetector.processOutput(data);

  // Check for server-side timing markers in the output
  const markerRegex = /__KP_(\w+)__/g;
  let match;
  while ((match = markerRegex.exec(data)) !== null) {
    const nonce = match[1];
    const recvTime = inputTimestamps.get(nonce);
    if (recvTime) {
      const now = process.hrtime.bigint();
      const serverProcessingNs = now - recvTime;
      const serverProcessingMs = Number(serverProcessingNs) / 1e6;
      inputTimestamps.delete(nonce);
      // Inject server timing into the output stream via a side-channel message
      broadcastToSession(sessionId, JSON.stringify({
        type: 'server_timing',
        nonce,
        serverMs: Math.round(serverProcessingMs * 100) / 100
      }), true);
    }
  }

  // Throttled output broadcast (same pattern as main project: 16ms coalescing)
  throttledOutputBroadcast(sessionId, data);
}

function throttledOutputBroadcast(sessionId, data) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session._pendingOutput += data;

  if (session._pendingOutput.length > MAX_COALESCE_BYTES) {
    if (session._outputFlushTimer) {
      clearTimeout(session._outputFlushTimer);
      session._outputFlushTimer = null;
    }
    // Flag C: yield to nextTick (input) before flushing
    if (has('C')) {
      setImmediate(() => flushSessionOutput(sessionId));
    } else {
      flushSessionOutput(sessionId);
    }
    return;
  }

  if (!session._outputFlushTimer) {
    session._outputFlushTimer = setTimeout(() => {
      session._outputFlushTimer = null;
      flushSessionOutput(sessionId);
    }, COALESCE_MS);
    if (session._outputFlushTimer.unref) {
      session._outputFlushTimer.unref();
    }
  }
}

function flushSessionOutput(sessionId) {
  const session = sessions.get(sessionId);
  if (!session || !session._pendingOutput) return;

  const pending = session._pendingOutput;
  session._pendingOutput = '';

  if (session.connections.size === 0) return;

  if (has('D')) {
    // Flag D: Binary WebSocket frames for terminal output
    const binaryMsg = Buffer.from(pending, 'utf-8');
    broadcastBinaryToSession(sessionId, binaryMsg);
  } else {
    // JSON (baseline)
    const msg = JSON.stringify({ type: 'output', data: pending });
    broadcastToSession(sessionId, msg, false);
  }
}

function broadcastToSession(sessionId, msg, isText = true) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.connections.forEach(wsId => {
    const wsInfo = wsConnections.get(wsId);
    if (wsInfo && wsInfo.ws.readyState === WebSocket.OPEN) {
      if (wsInfo.ws.bufferedAmount > 256 * 1024) return;
      wsInfo.ws.send(msg);
    }
  });
}

function broadcastBinaryToSession(sessionId, buf) {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.connections.forEach(wsId => {
    const wsInfo = wsConnections.get(wsId);
    if (wsInfo && wsInfo.ws.readyState === WebSocket.OPEN) {
      if (wsInfo.ws.bufferedAmount > 256 * 1024) return;
      wsInfo.ws.send(buf);
    }
  });
}

function onPtyExit(sessionId, code, signal) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session._outputFlushTimer) {
    clearTimeout(session._outputFlushTimer);
    session._outputFlushTimer = null;
  }
  if (session._pendingOutput) {
    flushSessionOutput(sessionId);
  }

  session.active = false;
  broadcastToSession(sessionId, JSON.stringify({ type: 'exit', code, signal }));
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  const flagList = FLAGS.size > 0 ? [...FLAGS].join(',') : 'none (baseline)';
  console.log(`ws-perf server on :${PORT}  flags=[${flagList}]`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  sessions.forEach((session) => {
    if (session.process) {
      try {
        if (session.process.kill) session.process.kill();
        else if (session.process.destroy) session.process.destroy();
      } catch (e) { /* ignore */ }
    }
  });
  server.close();
  process.exit(0);
});

module.exports = { server, PORT, FLAGS };
