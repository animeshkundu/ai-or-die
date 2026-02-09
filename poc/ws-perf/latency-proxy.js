'use strict';

/**
 * TCP latency proxy — simulates real network conditions between client and server.
 *
 * Supports fixed delay and DevTunnel-realistic jitter patterns.
 *
 * Usage:
 *   node latency-proxy.js [--delay <ms|preset>] [--jitter <ms>] [--listen <port>] [--target <port>]
 *
 * Presets model real-world conditions:
 *   localhost    — 0ms (pass-through)
 *   lan          — 3ms fixed
 *   regional     — 20ms base + 5ms jitter
 *   cross-country — 40ms base + 10ms jitter
 *   devtunnel    — 60ms base + 30ms jitter + occasional 200-500ms spikes (1 in 20 packets)
 *   devtunnel-bad — 100ms base + 80ms jitter + frequent 300-800ms spikes (1 in 8 packets)
 */

const net = require('net');

const PRESETS = {
  localhost:       { delay: 0,   jitter: 0,   spikeChance: 0,     spikeMin: 0,   spikeMax: 0 },
  lan:             { delay: 3,   jitter: 1,   spikeChance: 0,     spikeMin: 0,   spikeMax: 0 },
  regional:        { delay: 20,  jitter: 5,   spikeChance: 0,     spikeMin: 0,   spikeMax: 0 },
  'cross-country': { delay: 40,  jitter: 10,  spikeChance: 0.02,  spikeMin: 100, spikeMax: 200 },
  devtunnel:       { delay: 60,  jitter: 30,  spikeChance: 0.05,  spikeMin: 200, spikeMax: 500 },
  'devtunnel-bad': { delay: 100, jitter: 80,  spikeChance: 0.12,  spikeMin: 300, spikeMax: 800 },
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    delay: 20,
    jitter: 0,
    spikeChance: 0,
    spikeMin: 0,
    spikeMax: 0,
    listenPort: 7878,
    targetPort: 7877,
    targetHost: '127.0.0.1',
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--delay' && args[i + 1]) {
      const val = args[++i];
      if (PRESETS[val]) {
        Object.assign(opts, PRESETS[val]);
      } else {
        opts.delay = parseInt(val, 10);
      }
    } else if (args[i] === '--jitter' && args[i + 1]) {
      opts.jitter = parseInt(args[++i], 10);
    } else if (args[i] === '--listen' && args[i + 1]) {
      opts.listenPort = parseInt(args[++i], 10);
    } else if (args[i] === '--target' && args[i + 1]) {
      opts.targetPort = parseInt(args[++i], 10);
    }
  }
  return opts;
}

function computeDelay(opts) {
  let d = opts.delay;

  // Add gaussian-ish jitter (sum of 3 uniform randoms approximates normal)
  if (opts.jitter > 0) {
    const u = (Math.random() + Math.random() + Math.random()) / 3;
    d += Math.round((u - 0.5) * 2 * opts.jitter);
  }

  // Occasional spikes (simulates DevTunnel relay congestion)
  if (opts.spikeChance > 0 && Math.random() < opts.spikeChance) {
    d += opts.spikeMin + Math.random() * (opts.spikeMax - opts.spikeMin);
  }

  return Math.max(0, Math.round(d));
}

function createDelayedPipe(source, dest, opts) {
  if (opts.delay <= 0 && opts.jitter <= 0 && opts.spikeChance <= 0) {
    source.pipe(dest);
    return;
  }

  // FIFO ordering: track the earliest allowed delivery time to prevent
  // out-of-order delivery which corrupts WebSocket/zlib frames.
  let nextDeliverAt = 0;

  source.on('data', (chunk) => {
    const d = computeDelay(opts);
    const now = Date.now();
    const deliverAt = Math.max(now + d, nextDeliverAt);
    nextDeliverAt = deliverAt + 1; // ensure strict ordering
    const actualDelay = deliverAt - now;

    if (actualDelay <= 0) {
      if (!dest.destroyed) dest.write(chunk);
    } else {
      setTimeout(() => {
        if (!dest.destroyed) dest.write(chunk);
      }, actualDelay);
    }
  });
}

function startProxy(opts) {
  return new Promise((resolve) => {
    const server = net.createServer((clientSocket) => {
      const targetSocket = net.createConnection(opts.targetPort, opts.targetHost);

      createDelayedPipe(clientSocket, targetSocket, opts);
      createDelayedPipe(targetSocket, clientSocket, opts);

      clientSocket.on('error', () => targetSocket.destroy());
      targetSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => targetSocket.destroy());
      targetSocket.on('close', () => clientSocket.destroy());
    });

    server.listen(opts.listenPort, () => {
      resolve(server);
    });
  });
}

// Run standalone
if (require.main === module) {
  const opts = parseArgs();
  startProxy(opts).then((server) => {
    const addr = server.address();
    const avgRtt = opts.delay * 2;
    const desc = opts.jitter > 0 ? `${avgRtt}ms avg RTT, ±${opts.jitter}ms jitter` : `${avgRtt}ms RTT`;
    const spikes = opts.spikeChance > 0 ? `, ${Math.round(opts.spikeChance * 100)}% spike chance` : '';
    console.log(`Latency proxy :${addr.port} → :${opts.targetPort} (${desc}${spikes})`);
  });
}

module.exports = { startProxy, PRESETS };
