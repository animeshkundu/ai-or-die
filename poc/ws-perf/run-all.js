'use strict';

/**
 * Orchestrator: runs the benchmark across all optimization configs and latency levels.
 *
 * Usage:
 *   node run-all.js              # Quick: localhost only, key configs
 *   node run-all.js --full       # Full: all latency levels, all configs
 *   node run-all.js --configs "baseline,A,A+B+C"  # Specific configs only
 */

const { spawn: cpSpawn } = require('child_process');
const path = require('path');
const { startProxy } = require('./latency-proxy');
const { run: runBenchmark } = require('./benchmark');

const SERVER_PORT = 7877;
const PROXY_PORT = 7878;

const ALL_CONFIGS = [
  { name: 'baseline', flags: '' },
  { name: '+A (TCP_NODELAY)', flags: 'A' },
  { name: '+B (CircBuf)', flags: 'B' },
  { name: '+C (InputPrio)', flags: 'C' },
  { name: '+D (Binary)', flags: 'D' },
  { name: '+E (PlanDetOpt)', flags: 'E' },
  { name: '+A+B+C', flags: 'A,B,C' },
  { name: '+A+B+C+D', flags: 'A,B,C,D' },
  { name: '+A+B+C+D+E', flags: 'A,B,C,D,E' },
  { name: '+ALL (no workers)', flags: 'ALL' },
];

// Worker threads config tested separately (higher risk)
const WORKER_CONFIGS = [
  { name: '+F (Workers)', flags: 'F' },
  { name: '+ALL+F', flags: 'ALLF' },
];

const { PRESETS } = require('./latency-proxy');

const QUICK_LATENCIES = [{ name: '0ms (localhost)', preset: 'localhost' }];
const FULL_LATENCIES = [
  { name: 'localhost', preset: 'localhost' },
  { name: 'regional (~40ms RTT)', preset: 'regional' },
  { name: 'devtunnel (~120ms RTT+jitter)', preset: 'devtunnel' },
  { name: 'devtunnel-bad (~200ms+spikes)', preset: 'devtunnel-bad' },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { full: false, configs: null, includeWorkers: false, probes: 30, duration: 10 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--full') opts.full = true;
    if (args[i] === '--workers') opts.includeWorkers = true;
    if (args[i] === '--probes' && args[i + 1]) opts.probes = parseInt(args[++i], 10);
    if (args[i] === '--duration' && args[i + 1]) opts.duration = parseInt(args[++i], 10);
    if (args[i] === '--configs' && args[i + 1]) {
      opts.configs = args[++i].split(',').map(s => s.trim());
    }
  }
  return opts;
}

function startServer(flags) {
  return new Promise((resolve, reject) => {
    const flagArg = flags || '';
    const serverScript = path.join(__dirname, 'server.js');
    const args = [serverScript, '--port', String(SERVER_PORT)];
    if (flagArg) args.push('--flags', flagArg);

    const proc = cpSpawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        proc.kill();
        reject(new Error('Server start timeout'));
      }
    }, 10000);

    proc.stdout.on('data', (data) => {
      const line = data.toString();
      if (line.includes('ws-perf server on') && !started) {
        started = true;
        clearTimeout(timeout);
        // Give the server a moment to stabilize
        setTimeout(() => resolve(proc), 300);
      }
    });

    proc.stderr.on('data', (data) => {
      // Ignore stderr noise but log worker-related errors
      const line = data.toString();
      if (line.includes('Error') || line.includes('error')) {
        console.error(`  [server stderr] ${line.trim()}`);
      }
    });

    proc.on('exit', (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code} before starting`));
      }
    });
  });
}

function killServer(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.killed) { resolve(); return; }
    proc.on('exit', () => resolve());
    proc.kill('SIGTERM');
    // Force kill after 3s
    setTimeout(() => {
      if (!proc.killed) {
        try { proc.kill('SIGKILL'); } catch (e) { /* ignore */ }
      }
      resolve();
    }, 3000);
  });
}

function formatMs(ms) {
  if (ms === 0 || ms === undefined || ms === null) return '-';
  return `${Math.round(ms)}ms`;
}

function printTable(allResults) {
  // Header
  const colWidths = {
    config: 22,
    latency: 30,
    samples: 8,
    p50: 8,
    p95: 8,
    p99: 8,
    max: 8,
    sp50: 10,
    sp95: 10,
  };

  const hr = '─'.repeat(colWidths.config + colWidths.latency + colWidths.samples +
    colWidths.p50 + colWidths.p95 + colWidths.p99 + colWidths.max +
    colWidths.sp50 + colWidths.sp95 + 10);

  console.log('\n' + hr);
  console.log(
    pad('Config', colWidths.config) +
    pad('Network', colWidths.latency) +
    pad('N', colWidths.samples) +
    pad('p50', colWidths.p50) +
    pad('p95', colWidths.p95) +
    pad('p99', colWidths.p99) +
    pad('max', colWidths.max) +
    pad('srv p50', colWidths.sp50) +
    pad('srv p95', colWidths.sp95)
  );
  console.log(hr);

  for (const r of allResults) {
    const totalP50 = formatMs(r.summary?.total?.p50);
    const totalP95 = formatMs(r.summary?.total?.p95);
    const totalP99 = formatMs(r.summary?.total?.p99);
    const totalMax = formatMs(r.summary?.total?.max);
    const srvP50 = r.summary?.server ? formatMs(r.summary.server.p50) : '-';
    const srvP95 = r.summary?.server ? formatMs(r.summary.server.p95) : '-';
    const samples = r.summary ? String(r.summary.samples) : 'ERR';

    // Color code: green if p95 < 50ms, yellow if < 100ms, red otherwise
    let color = '';
    let reset = '';
    if (r.summary) {
      const p95val = r.summary.total.p95;
      if (p95val < 50) { color = '\x1b[32m'; reset = '\x1b[0m'; }
      else if (p95val < 100) { color = '\x1b[33m'; reset = '\x1b[0m'; }
      else { color = '\x1b[31m'; reset = '\x1b[0m'; }
    }

    console.log(
      color +
      pad(r.config, colWidths.config) +
      pad(r.latency, colWidths.latency) +
      pad(samples, colWidths.samples) +
      pad(totalP50, colWidths.p50) +
      pad(totalP95, colWidths.p95) +
      pad(totalP99, colWidths.p99) +
      pad(totalMax, colWidths.max) +
      pad(srvP50, colWidths.sp50) +
      pad(srvP95, colWidths.sp95) +
      reset
    );
  }
  console.log(hr);
}

function pad(str, width) {
  return String(str).padEnd(width);
}

async function runSingleBenchmark(configName, flags, latencyName, latencyPreset, probes, duration) {
  let serverProc = null;
  let proxyServer = null;

  try {
    // Start server
    serverProc = await startServer(flags);

    let wsUrl;
    const presetOpts = PRESETS[latencyPreset] || PRESETS.localhost;
    if (presetOpts.delay > 0 || presetOpts.jitter > 0) {
      // Start proxy with full preset (delay + jitter + spikes)
      proxyServer = await startProxy({
        ...presetOpts,
        listenPort: PROXY_PORT,
        targetPort: SERVER_PORT,
        targetHost: '127.0.0.1',
      });
      wsUrl = `ws://127.0.0.1:${PROXY_PORT}`;
    } else {
      wsUrl = `ws://127.0.0.1:${SERVER_PORT}`;
    }

    const summary = await runBenchmark({
      url: wsUrl,
      probes,
      duration,
      quiet: true,
    });

    return { config: configName, latency: latencyName, summary };
  } catch (err) {
    console.error(`  ERROR [${configName} @ ${latencyName}]: ${err.message}`);
    return { config: configName, latency: latencyName, summary: null, error: err.message };
  } finally {
    if (proxyServer) {
      proxyServer.close();
    }
    if (serverProc) {
      await killServer(serverProc);
    }
    // Brief pause between runs
    await new Promise(r => setTimeout(r, 500));
  }
}

async function main() {
  const opts = parseArgs();
  const latencies = opts.full ? FULL_LATENCIES : QUICK_LATENCIES;

  let configs = ALL_CONFIGS;
  if (opts.includeWorkers) {
    configs = [...ALL_CONFIGS, ...WORKER_CONFIGS];
  }
  if (opts.configs) {
    configs = configs.filter(c =>
      opts.configs.some(name =>
        c.name.toLowerCase().includes(name.toLowerCase()) ||
        c.flags.toLowerCase() === name.toLowerCase()
      )
    );
  }

  const totalRuns = configs.length * latencies.length;
  console.log(`\nWebSocket I/O Performance Benchmark`);
  console.log(`===================================`);
  console.log(`Configs: ${configs.length}  |  Latency levels: ${latencies.length}  |  Total runs: ${totalRuns}`);
  console.log(`Probes per run: ${opts.probes}  |  Duration: ${opts.duration}s`);
  console.log('');

  const allResults = [];
  let runNum = 0;

  for (const latency of latencies) {
    for (const config of configs) {
      runNum++;
      console.log(`[${runNum}/${totalRuns}] ${config.name} @ ${latency.name}...`);

      const result = await runSingleBenchmark(
        config.name,
        config.flags,
        latency.name,
        latency.preset,
        opts.probes,
        opts.duration
      );

      if (result.summary) {
        const p50 = result.summary.total.p50;
        const p95 = result.summary.total.p95;
        const srvP50 = result.summary.server ? result.summary.server.p50.toFixed(1) : '-';
        console.log(`  => p50=${p50}ms  p95=${p95}ms  server_p50=${srvP50}ms  (${result.summary.samples} samples)`);
      }

      allResults.push(result);
    }
  }

  printTable(allResults);

  // Summary analysis
  console.log('\nAnalysis:');
  const baselineLocal = allResults.find(r => r.config === 'baseline' && r.latency.includes('localhost'));
  const bestLocal = allResults
    .filter(r => r.latency.includes('localhost') && r.summary)
    .sort((a, b) => (a.summary.total.p95 || 999) - (b.summary.total.p95 || 999))[0];

  if (baselineLocal?.summary && bestLocal?.summary) {
    const improvement = baselineLocal.summary.total.p95 - bestLocal.summary.total.p95;
    console.log(`  Baseline p95: ${baselineLocal.summary.total.p95}ms`);
    console.log(`  Best p95:     ${bestLocal.summary.total.p95}ms (${bestLocal.config})`);
    console.log(`  Improvement:  ${improvement}ms (${Math.round(improvement / baselineLocal.summary.total.p95 * 100)}%)`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
