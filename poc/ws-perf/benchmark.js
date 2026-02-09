'use strict';

/**
 * Benchmark client that measures keystroke round-trip latency under heavy output.
 *
 * Usage:
 *   node benchmark.js [--url ws://host:port] [--probes 30] [--duration 10]
 *
 * Protocol:
 *   1. Connects to the server, starts a session
 *   2. Triggers heavy ANSI output via a shell loop
 *   3. Sends keystroke probes (echo __KP_<nonce>__) at random intervals
 *   4. Measures time from send to seeing the marker echoed in output
 *   5. Collects server_timing side-channel messages for server-only latency
 */

const WebSocket = require('ws');
const crypto = require('crypto');
const os = require('os');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    url: 'ws://127.0.0.1:7777',
    probes: 30,
    duration: 10,
    quiet: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) opts.url = args[++i];
    else if (args[i] === '--probes' && args[i + 1]) opts.probes = parseInt(args[++i], 10);
    else if (args[i] === '--duration' && args[i + 1]) opts.duration = parseInt(args[++i], 10);
    else if (args[i] === '--quiet') opts.quiet = true;
  }
  return opts;
}

function nonce() {
  return crypto.randomBytes(4).toString('hex');
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function run(opts) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(opts.url);
    const results = [];            // { nonce, totalMs, serverMs }
    const pendingProbes = new Map(); // nonce → { t_send }
    const serverTimings = new Map(); // nonce → serverMs
    let sessionStarted = false;
    let outputBuffer = '';
    let probesSent = 0;
    let probeTimeout = null;
    let doneTimer = null;
    let binaryMode = false;
    let heavyOutputStarted = false;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'start_session',
        sessionId: `bench_${Date.now()}`,
        cols: 120,
        rows: 40,
      }));
    });

    ws.on('message', (rawData, isBinary) => {
      const str = rawData.toString('utf-8');
      let text;
      let isOutput = false;

      if (isBinary) {
        // Binary WebSocket frame = raw terminal output (flag D active)
        text = str;
        binaryMode = true;
        isOutput = true;
      } else {
        // Text frame: try to parse as JSON control message
        try {
          const msg = JSON.parse(str);
          if (msg.type === 'session_started') {
            sessionStarted = true;
            if (!opts.quiet) console.log(`  Session started: ${msg.sessionId}`);
            startHeavyOutput();
            return;
          }
          if (msg.type === 'server_timing') {
            serverTimings.set(msg.nonce, msg.serverMs);
            checkProbeCompletion(msg.nonce);
            return;
          }
          if (msg.type === 'output') {
            text = msg.data;
            isOutput = true;
          }
          if (msg.type === 'connected') {
            if (!opts.quiet) {
              console.log(`  Connected (flags: ${msg.flags ? msg.flags.join(',') : 'none'})`);
            }
            return;
          }
          if (msg.type === 'flood_started') {
            if (!opts.quiet) console.log(`  Flood started (${msg.duration}s)`);
            return;
          }
          if (msg.type === 'exit') {
            finalize();
            return;
          }
        } catch (e) {
          // Not JSON — treat as raw text output
          text = str;
          isOutput = true;
        }
      }

      if (!isOutput || !text) return;

      // Scan output for our markers
      outputBuffer += text;
      const markerRegex = /__KP_(\w+)__/g;
      let match;
      while ((match = markerRegex.exec(outputBuffer)) !== null) {
        const probeNonce = match[1];
        checkProbeCompletion(probeNonce);
      }

      // Trim buffer to prevent unbounded growth
      if (outputBuffer.length > 100000) {
        outputBuffer = outputBuffer.slice(-50000);
      }
    });

    function checkProbeCompletion(probeNonce) {
      const pending = pendingProbes.get(probeNonce);
      if (!pending) return;

      // Check if we've seen both: marker in output AND (optionally) server timing
      const seenInOutput = outputBuffer.includes(`__KP_${probeNonce}__`);
      if (!seenInOutput) return;

      const now = Date.now();
      const totalMs = now - pending.t_send;
      const serverMs = serverTimings.get(probeNonce) || null;

      results.push({ nonce: probeNonce, totalMs, serverMs });
      pendingProbes.delete(probeNonce);
      serverTimings.delete(probeNonce);

      if (!opts.quiet) {
        const serverStr = serverMs !== null ? `${serverMs.toFixed(1)}ms server` : 'no server timing';
        console.log(`  Probe ${results.length}/${opts.probes}: ${totalMs}ms total (${serverStr})`);
      }

      if (results.length >= opts.probes) {
        finalize();
      }
    }

    function startHeavyOutput() {
      if (heavyOutputStarted) return;
      heavyOutputStarted = true;

      const duration = opts.duration;

      // Use server-side flood generator — pumps heavy ANSI output through
      // the output pipeline while the PTY remains free for probe echo commands.
      // Rate: ~500KB/sec to simulate Claude's heavy planning output.
      // 100 lines/burst * ~100 bytes/line = ~10KB/burst at 16ms interval = ~625KB/sec
      ws.send(JSON.stringify({
        type: 'start_flood',
        duration,
        interval: 16,   // 16ms between bursts (~62 bursts/sec, matches coalesce window)
        lines: 100,     // 100 lines per burst (~10KB each = ~625KB/sec)
      }));

      // Wait for shell to fully initialize and flood to ramp up
      // PowerShell needs ~3s to finish startup banner
      const shellReadyDelay = os.platform() === 'win32' ? 3000 : 500;
      setTimeout(() => {
        scheduleNextProbe();
      }, shellReadyDelay);

      // Safety timeout
      doneTimer = setTimeout(() => {
        if (!opts.quiet) console.log('  Timeout reached, finalizing...');
        finalize();
      }, (duration + 10) * 1000);
    }

    function scheduleNextProbe() {
      if (probesSent >= opts.probes || !sessionStarted) return;

      // Random interval: 100-500ms between probes
      const delay = 100 + Math.random() * 400;
      probeTimeout = setTimeout(() => {
        sendProbe();
        scheduleNextProbe();
      }, delay);
    }

    function sendProbe() {
      if (probesSent >= opts.probes) return;
      const n = nonce();
      const t_send = Date.now();

      // Send echo command with unique marker.
      // `echo` works in both bash and PowerShell.
      // Use \r\n which is safe for both shells.
      const cmd = `echo __KP_${n}__\r\n`;

      pendingProbes.set(n, { t_send });
      ws.send(JSON.stringify({ type: 'input', data: cmd }));
      probesSent++;
    }

    let finalized = false;
    function finalize() {
      if (finalized) return;
      finalized = true;

      if (probeTimeout) clearTimeout(probeTimeout);
      if (doneTimer) clearTimeout(doneTimer);

      // Give a moment for any remaining messages
      setTimeout(() => {
        ws.close();

        const totalLatencies = results.map(r => r.totalMs);
        const serverLatencies = results.filter(r => r.serverMs !== null).map(r => r.serverMs);

        const summary = {
          samples: results.length,
          total: {
            p50: percentile(totalLatencies, 50),
            p95: percentile(totalLatencies, 95),
            p99: percentile(totalLatencies, 99),
            max: Math.max(...totalLatencies, 0),
            min: Math.min(...totalLatencies, 0),
          },
          server: serverLatencies.length > 0 ? {
            p50: percentile(serverLatencies, 50),
            p95: percentile(serverLatencies, 95),
            p99: percentile(serverLatencies, 99),
            max: Math.max(...serverLatencies),
            min: Math.min(...serverLatencies),
          } : null,
          binaryMode,
        };

        resolve(summary);
      }, 500);
    }

    ws.on('error', (err) => {
      reject(err);
    });

    ws.on('close', () => {
      if (!finalized) finalize();
    });
  });
}

// Standalone execution
if (require.main === module) {
  const opts = parseArgs();
  console.log(`Benchmark: ${opts.url} (${opts.probes} probes, ${opts.duration}s duration)`);
  run(opts).then((summary) => {
    console.log('\n--- Results ---');
    console.log(`Samples: ${summary.samples}`);
    console.log(`Binary mode: ${summary.binaryMode}`);
    console.log(`Total RTT:    p50=${summary.total.p50}ms  p95=${summary.total.p95}ms  p99=${summary.total.p99}ms  max=${summary.total.max}ms`);
    if (summary.server) {
      console.log(`Server only:  p50=${summary.server.p50}ms  p95=${summary.server.p95}ms  p99=${summary.server.p99}ms  max=${summary.server.max}ms`);
    }
  }).catch((err) => {
    console.error('Benchmark failed:', err.message);
    process.exit(1);
  });
}

module.exports = { run };
