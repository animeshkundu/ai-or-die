#!/usr/bin/env node
'use strict';

/**
 * summarize.js — print a compact stats table from a soak run's samples.jsonl
 *
 * Usage: node test/longevity/harness/summarize.js <results-dir> [--markdown]
 *
 * Output: per-(gate, metric) min / median / p95 / p99 / max + overall
 * pass/fail per gate. Used to produce BASELINE.md and for SUP-REL's PR diff
 * comments without re-loading the harness.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length));
  return sorted[idx];
}

async function loadSamples(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const groups = new Map();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try { row = JSON.parse(trimmed); } catch (_) { continue; }
    if (typeof row.value !== 'number') continue;
    const key = `${row.gate}::${row.metric}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row.value);
  }
  return groups;
}

function summarize(groups) {
  const rows = [];
  for (const [key, values] of groups) {
    const [gate, metric] = key.split('::');
    const sorted = values.slice().sort((a, b) => a - b);
    rows.push({
      gate, metric,
      n: values.length,
      min: sorted[0],
      median: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted[sorted.length - 1],
    });
  }
  rows.sort((a, b) => a.gate.localeCompare(b.gate) || a.metric.localeCompare(b.metric));
  return rows;
}

function fmt(n) {
  if (n == null) return '—';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3);
}

function printTable(rows, asMd = false) {
  const header = ['gate', 'metric', 'n', 'min', 'p50', 'p95', 'p99', 'max'];
  if (asMd) {
    console.log('| ' + header.join(' | ') + ' |');
    console.log('|' + header.map(() => '---').join('|') + '|');
    for (const r of rows) {
      console.log(`| ${r.gate} | ${r.metric} | ${r.n} | ${fmt(r.min)} | ${fmt(r.median)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${fmt(r.max)} |`);
    }
  } else {
    const widths = header.map(h => h.length);
    const allRows = rows.map(r => [r.gate, r.metric, String(r.n), fmt(r.min), fmt(r.median), fmt(r.p95), fmt(r.p99), fmt(r.max)]);
    for (const row of allRows) {
      for (let i = 0; i < header.length; i++) {
        if (row[i].length > widths[i]) widths[i] = row[i].length;
      }
    }
    const pad = (s, w) => s.padEnd(w);
    console.log(header.map((h, i) => pad(h, widths[i])).join('  '));
    console.log(widths.map(w => '-'.repeat(w)).join('  '));
    for (const row of allRows) {
      console.log(row.map((c, i) => pad(c, widths[i])).join('  '));
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dir = args.find(a => !a.startsWith('--'));
  const asMd = args.includes('--markdown');
  if (!dir) {
    console.error('Usage: summarize.js <results-dir> [--markdown]');
    process.exit(2);
  }
  const samples = path.join(dir, 'samples.jsonl');
  const verdict = path.join(dir, 'gate-result.json');
  const meta = path.join(dir, 'metadata.json');

  const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
  const v = JSON.parse(fs.readFileSync(verdict, 'utf8'));

  if (asMd) {
    console.log(`# Soak summary: ${path.basename(dir)}\n`);
    console.log(`- **Started**: ${m.started_at}`);
    console.log(`- **Finished**: ${m.finished_at}`);
    console.log(`- **Duration**: ${(m.duration_ms / 1000).toFixed(0)}s`);
    console.log(`- **Workloads**: ${m.workloads.join(', ')}`);
    console.log(`- **Samples**: ${m.sampler_stats.samples} (errors: ${m.sampler_stats.errors})`);
    console.log(`- **Node**: ${m.node_version} ${m.platform}/${m.arch}`);
    if (m.pr) console.log(`- **PR**: ${m.pr}`);
    console.log('');
    console.log(`## Overall verdict: \`${v.overall}\`\n`);
    console.log('| gate | pass | summary |');
    console.log('|---|---|---|');
    for (const g of v.gates) {
      const verdict = g.pass === true ? 'PASS' : g.pass === false ? 'FAIL' : 'N/A';
      console.log(`| \`${g.name}\` | \`${verdict}\` | ${g.summary || ''} |`);
    }
    console.log('\n## Sampled distributions\n');
  } else {
    console.log(`Soak summary: ${path.basename(dir)}`);
    console.log(`  duration=${(m.duration_ms / 1000).toFixed(0)}s workloads=${m.workloads.join(',')}`);
    console.log(`  samples=${m.sampler_stats.samples} errors=${m.sampler_stats.errors}`);
    console.log(`  node=${m.node_version} ${m.platform}/${m.arch}`);
    console.log(`  overall=${v.overall}`);
    console.log('');
    for (const g of v.gates) {
      const verdict = g.pass === true ? 'PASS' : g.pass === false ? 'FAIL' : 'N/A ';
      console.log(`  [${verdict}] ${g.name.padEnd(12)} ${g.summary || ''}`);
    }
    console.log('');
  }

  const groups = await loadSamples(samples);
  const rows = summarize(groups);
  printTable(rows, asMd);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { loadSamples, summarize };
