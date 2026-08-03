'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const realStore = path.join(os.homedir(), '.ai-or-die');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-or-die-test-sessions-'));
const processEvents = [
  'SIGINT',
  'SIGTERM',
  'beforeExit',
  'uncaughtException',
  'unhandledRejection',
  'message',
  'disconnect',
];
let baselineListeners;

process.env.AI_OR_DIE_SESSION_DIR = sandbox;
process.env.AI_OR_DIE_TEST_SESSION_SANDBOX = sandbox;

// Writes this process attempted against the real store. Populated by the fs
// guard below; asserted empty in afterAll.
const violations = [];

// Why this is a syscall guard and not a before/after directory diff:
//
// The obvious check — snapshot ~/.ai-or-die at suite start, compare at the end —
// cannot distinguish "a test wrote here" from "the developer's own ai-or-die
// server, running on this machine, autosaved its sessions". The server persists
// every 30s, so on any machine where the app is actually running (the normal
// case for this project) that check fails for reasons no test controls. It
// passed in CI only because no live instance exists there.
//
// What we actually want to guarantee is narrower and fully in our control: THIS
// process must never open the real store for writing. Enforcing that at the fs
// boundary is deterministic, immune to other processes, and names the exact
// call site instead of reporting an opaque directory delta.

const WRITE_FLAG = /[wa+]/;

function underRealStore(target) {
  if (typeof target !== 'string') {
    if (Buffer.isBuffer(target)) target = target.toString();
    else if (target instanceof URL) target = target.pathname;
    else return false;
  }
  let resolved;
  try { resolved = path.resolve(target); } catch (_) { return false; }
  const base = process.platform === 'win32' ? realStore.toLowerCase() : realStore;
  const candidate = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return candidate === base || candidate.startsWith(base + path.sep);
}

function record(fnName, target) {
  const error = new Error(`test wrote to the real store via fs.${fnName}: ${target}`);
  violations.push({ fn: fnName, target: String(target), stack: error.stack });
}

// Functions whose FIRST argument is a path they may write to.
const PATH_WRITERS = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync',
  'mkdir', 'mkdirSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
  'unlink', 'unlinkSync', 'truncate', 'truncateSync',
  'createWriteStream', 'chmod', 'chmodSync', 'utimes', 'utimesSync',
];
// Functions with a (src, dest) shape where the DESTINATION is written.
const PATH_PAIR_WRITERS = ['rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'link', 'linkSync'];

function guard(namespace, fnName, pick) {
  const original = namespace[fnName];
  if (typeof original !== 'function') return;
  namespace[fnName] = function guarded(...args) {
    const target = pick(args);
    if (underRealStore(target)) record(fnName, target);
    return original.apply(this, args);
  };
}

for (const fnName of PATH_WRITERS) {
  guard(fs, fnName, (args) => args[0]);
  if (fs.promises) guard(fs.promises, fnName, (args) => args[0]);
}
for (const fnName of PATH_PAIR_WRITERS) {
  guard(fs, fnName, (args) => args[1]);
  if (fs.promises) guard(fs.promises, fnName, (args) => args[1]);
}
// open()/openSync() only count when the flag actually permits writing.
for (const fnName of ['open', 'openSync']) {
  guard(fs, fnName, (args) => (WRITE_FLAG.test(String(args[1] ?? 'r')) ? args[0] : null));
  if (fs.promises) guard(fs.promises, fnName, (args) => (WRITE_FLAG.test(String(args[1] ?? 'r')) ? args[0] : null));
}

exports.mochaHooks = {
  beforeAll() {
    baselineListeners = new Map(processEvents.map((event) => [event, process.listenerCount(event)]));
  },
  afterAll() {
    for (const event of processEvents) {
      assert.strictEqual(
        process.listenerCount(event),
        baselineListeners.get(event),
        `process listener count for ${event} must return to the suite baseline`
      );
    }
    if (violations.length) {
      const detail = violations
        .map((v) => `  fs.${v.fn} -> ${v.target}\n${v.stack.split('\n').slice(1, 5).join('\n')}`)
        .join('\n\n');
      assert.fail(`tests must never write to the real ${realStore}:\n\n${detail}`);
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  },
};
