#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { analyzeHeapSnapshot } = require('./heap-snapshot-analyzer');
const {
  closeProcServer,
  diagnosticRequest,
  startProcServer,
} = require('./proc-controller');
const { createThenDisconnect } = require('./memory-diagnosis');

function parseArgs(argv) {
  const args = {};
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const index = raw.indexOf('=');
    args[index === -1 ? raw.slice(2) : raw.slice(2, index)] =
      index === -1 ? true : raw.slice(index + 1);
  }
  return args;
}

function currentHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.join(__dirname, '..', '..', '..'),
      encoding: 'utf8',
    }).trim();
  } catch (_) {
    return process.env.GITHUB_SHA || null;
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const operations = Number(args.operations || 100);
  const output = path.resolve(args.out || 'session-dominators.json');
  const controller = await startProcServer();
  let snapshotPath = null;
  try {
    for (let i = 0; i < operations; i++) {
      await createThenDisconnect(controller.wsUrl, i);
    }
    const counters = await diagnosticRequest(controller, '/api/_diag/gc', {
      method: 'POST',
      body: {},
    });
    if (counters.statusCode !== 200) {
      throw new Error(`counter capture failed: HTTP ${counters.statusCode}`);
    }
    const snapshot = await diagnosticRequest(controller, '/api/_diag/heapsnapshot', {
      method: 'POST',
      body: {},
    });
    if (snapshot.statusCode !== 200) {
      throw new Error(`snapshot capture failed: HTTP ${snapshot.statusCode}`);
    }
    snapshotPath = snapshot.body.path;
    const [snapshotSha256, analysis] = await Promise.all([
      sha256File(snapshotPath),
      analyzeHeapSnapshot(snapshotPath, { limit: Number(args.limit || 100) }),
    ]);
    const result = {
      metadata: {
        captured_at: new Date().toISOString(),
        head: currentHead(),
        node_version: process.version,
        platform: process.platform,
        operations,
        snapshot_bytes: snapshot.body.bytes,
        snapshot_sha256: snapshotSha256,
        raw_snapshot_committed: false,
      },
      ownership_counters: {
        sessions: counters.body.sessions,
        persistence: counters.body.persistence,
      },
      analysis,
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
    process.stdout.write(JSON.stringify({ output, metadata: result.metadata }, null, 2) + '\n');
  } finally {
    if (snapshotPath) {
      try { fs.unlinkSync(snapshotPath); } catch (_) {}
    }
    await closeProcServer(controller);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs, sha256File };
