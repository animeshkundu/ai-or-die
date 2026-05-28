'use strict';

/**
 * CLI entry point for `npm run soak`.
 *
 * Flags (all optional):
 *   --duration=<n><s|m|h>   e.g. 60s, 10m, 4h          default 60s
 *   --workloads=a,b,c       comma list of workload names  default noop
 *   --gates=a,b,c           comma list of gate names      default all
 *   --interval=<n><s|m>     diagnostics sample cadence    default ⌊duration/6⌋, max 30s
 *   --seed=<int>            RNG seed                      default 42
 *   --pr=<tag>              tag embedded in metadata.json (for SUP-REL re-runs)
 *   --label=<slug>          appended to the results dir name
 *   --out=<dir>             override results dir          default test/longevity/results/<utc>
 *   --json                  emit verdict as JSON on stdout (for CI scraping)
 *
 * Exit code: 0 on overall pass, 1 on any failed gate or abort.
 * Indeterminate verdicts (insufficient samples) exit 0 — the harness can't
 * judge what didn't happen.
 */

const path = require('path');
const { runSoak, utcLabel, defaultResultsRoot } = require('./runner');
const { listWorkloads } = require('./workloads');
const { GATES } = require('./gates');

function parseDuration(s) {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(String(s).trim());
  if (!m) throw new Error(`bad duration: ${s}`);
  const n = parseInt(m[1], 10);
  const unit = m[2] || 's';
  const mul = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit];
  return n * mul;
}

function parseArgs(argv) {
  const args = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const eq = raw.indexOf('=');
    const k = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    const v = eq === -1 ? true : raw.slice(eq + 1);
    args[k] = v;
  }
  return args;
}

function printHelp() {
  /* eslint-disable no-console */
  console.log('Usage: node test/longevity/harness/cli.js [flags]');
  console.log('');
  console.log('Flags:');
  console.log('  --duration=60s|10m|4h   soak window           (default 60s)');
  console.log('  --workloads=a,b         workload selection    (default noop; "all" expands registry)');
  console.log('  --gates=a,b             gate selection        (default all)');
  console.log('  --interval=30s          sample cadence        (default ⌊duration/6⌋, max 30s)');
  console.log('  --seed=42               RNG seed              (default 42)');
  console.log('  --pr=123                tag in metadata.json  (optional)');
  console.log('  --label=baseline        appended to results dir (optional)');
  console.log('  --out=/abs/dir          override results dir  (optional)');
  console.log('  --json                  print verdict JSON to stdout');
  console.log('  --help');
  console.log('');
  console.log(`Workloads: ${listWorkloads().join(', ')}`);
  console.log(`Gates:     ${GATES.map(g => g.name).join(', ')}`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || args.h) { printHelp(); process.exit(0); }

  const durationMs = parseDuration(args.duration || '60s');
  // `--workloads=all` expands to every registered workload — keeps ci.yml clean
  // when SUP-REL wires the nightly soak (REL-01).
  const workloadArg = args.workloads || 'noop';
  const workloads = workloadArg === 'all'
    ? listWorkloads()
    : workloadArg.split(',').map(s => s.trim()).filter(Boolean);
  const gates = args.gates ? args.gates.split(',').map(s => s.trim()).filter(Boolean) : null;
  const sampleIntervalMs = args.interval ? parseDuration(args.interval) : undefined;
  const seed = args.seed ? parseInt(args.seed, 10) : 42;
  const prTag = args.pr || null;
  const label = args.label || null;

  let outputDir = args.out;
  if (!outputDir) {
    const stamp = utcLabel();
    const suffix = label ? `-${label}` : '';
    outputDir = path.join(defaultResultsRoot(), `${stamp}${suffix}`);
  }

  const result = await runSoak({
    durationMs,
    workloads,
    gates,
    sampleIntervalMs,
    seed,
    prTag,
    label,
    outputDir,
  });

  if (args.json) {
    process.stdout.write(JSON.stringify({
      output_dir: result.outputDir,
      overall: result.evaluation.overall,
      gates: result.evaluation.gates,
      sampler: result.samplerStats,
    }, null, 2) + '\n');
  } else {
    /* eslint-disable no-console */
    console.log('');
    console.log(`Soak result: overall=${result.evaluation.overall}`);
    console.log(`Output dir : ${result.outputDir}`);
    console.log(`Samples    : ${result.samplerStats.samples}`);
    console.log('');
    console.log('Per-gate verdict:');
    for (const g of result.evaluation.gates) {
      const verdict = g.pass === true ? 'PASS' : g.pass === false ? 'FAIL' : 'N/A ';
      console.log(`  [${verdict}] ${g.name.padEnd(12)} ${g.summary || ''}`);
    }
  }

  if (result.aborted) process.exit(1);
  // overall === null (no decidable gates) counts as informational, not failure
  process.exit(result.evaluation.overall === false ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[soak/cli] fatal: ${err.stack || err.message}\n`);
    process.exit(2);
  });
}

module.exports = { main, parseDuration, parseArgs };
