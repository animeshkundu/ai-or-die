'use strict';

/**
 * Workload registry. SOAK-02 ships all seven plan-file workloads.
 *
 * Reference them from the CLI with `--workloads=name1,name2`.
 *
 *   noop                — smoke path; no server interaction
 *   pty-flood           — ~5MB/s OSC 7 + bulk bytes across 8 simulated tabs
 *   reconnect-storm     — 50 WS tabs cycling connect/disconnect at 1Hz
 *   watcher-flood       — 100 fs ops/s across 5 watched dirs, mixed hash mode
 *   ws-fuzz             — 10Hz binary frames at 1KB / 100KB / 4MB / 10MB
 *   attachment-growth   — 1000-file dir + probe rate
 *   session-stringify   — 500 sessions × 200KB, repeated save sweeps
 *   mock-clock          — 90d-old session inject + eviction sweeps
 */

const { NoopWorkload } = require('./noop-workload');
const { PtyFloodWorkload } = require('./pty-flood-workload');
const { PtyFloodWsWorkload } = require('./pty-flood-ws-workload');
const { ReconnectStormWorkload } = require('./reconnect-storm-workload');
const { WatcherFloodWorkload } = require('./watcher-flood-workload');
const { WsFuzzWorkload } = require('./ws-fuzz-workload');
const { AttachmentGrowthWorkload } = require('./attachment-growth-workload');
const { SessionStringifyWorkload } = require('./session-stringify-workload');
const { MockClockWorkload } = require('./mock-clock-workload');
const { DiskBloatJsonlWorkload } = require('./disk-bloat-jsonl-workload');
const { DiskBloatQuotaWorkload } = require('./disk-bloat-quota-workload');

const WORKLOADS = {
  'noop':              NoopWorkload,
  'pty-flood':         PtyFloodWorkload,
  'pty-flood-ws':      PtyFloodWsWorkload,
  'reconnect-storm':   ReconnectStormWorkload,
  'watcher-flood':     WatcherFloodWorkload,
  'ws-fuzz':           WsFuzzWorkload,
  'attachment-growth': AttachmentGrowthWorkload,
  'session-stringify': SessionStringifyWorkload,
  'mock-clock':        MockClockWorkload,
  'disk-bloat-jsonl':  DiskBloatJsonlWorkload,
  'disk-bloat-quota':  DiskBloatQuotaWorkload,
};

function getWorkload(name) {
  const Ctor = WORKLOADS[name];
  if (!Ctor) {
    throw new Error(`Unknown workload "${name}". Known: ${Object.keys(WORKLOADS).join(', ')}`);
  }
  return Ctor;
}

function listWorkloads() { return Object.keys(WORKLOADS); }

module.exports = { WORKLOADS, getWorkload, listWorkloads };
