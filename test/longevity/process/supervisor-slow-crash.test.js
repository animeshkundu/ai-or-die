// test/longevity/process/supervisor-slow-crash.test.js
//
// PROC-01 regression test — supervisor circuit-breaker & slow-crash escalation
//
// Memo: docs/audits/proc-supervisor-breaker.md
//
// What this proves on main HEAD:
//
//   The pre-fix supervisor calls process.exit(1) after 3 crashes within
//   30s — a hard stop. For a single-user, months-long daemon this
//   strands the user with no daemon to talk to. Simultaneously, a
//   slow-steady crash cadence (e.g. one crash every 31s) bypasses the
//   30s window entirely and respawns forever, burning CPU and masking
//   the underlying bug.
//
//   The fix introduces two tiers:
//     • Tier 1: 3 crashes in 30s window → restart delay = 60s (was: exit 1)
//     • Tier 2: 5 crashes in 1h window → restart delay = 5min + IPC warning
//   The supervisor NEVER permanently exits on a crash sequence.
//
// Test strategy: shrink all the tunables via env vars (30s→200ms, 1h→2s,
// 60s→120ms, 5min→240ms, 3s→20ms) so the four scenarios complete in
// seconds instead of hours. Use SUPERVISOR_ESCALATION_OBSERVER=1 to make
// the supervisor emit IPC {type:'supervisor_escalation', tier, count, ...}
// so the test can deterministically watch tier transitions without parsing
// log strings.
//
// On main (pre-fix): scenario 1 fails — supervisor process exits with
// code 1 instead of staying alive and escalating to tier 1.
// On main pre-fix scenario 3 also has no notion of tier 2 → fails.

'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const SUPERVISOR_SCRIPT = path.join(__dirname, '..', '..', '..', 'bin', 'supervisor.js');
const MOCK_CRASHING_SERVER = path.join(__dirname, '..', '..', 'fixtures', 'mock-crashing-server.js');

// Shrunken windows / delays so the suite finishes in seconds. Map to the
// production defaults in bin/supervisor.js — see proc-supervisor-breaker.md.
const SHRUNK_ENV = {
  CIRCUIT_BREAKER_WINDOW_MS: '200',   // tier-1 window (prod: 30000)
  CIRCUIT_BREAKER_MAX_CRASHES: '3',
  SUSTAINED_CRASH_WINDOW_MS: '2000',  // tier-2 window (prod: 3600000)
  SUSTAINED_CRASH_MAX: '5',
  TIER1_RESTART_DELAY_MS: '120',      // (prod: 60000)
  TIER2_RESTART_DELAY_MS: '240',      // (prod: 300000)
  CRASH_RESTART_DELAY_MS: '20',       // (prod: 3000)
  RESTART_DELAY_MS: '20',
  SHUTDOWN_TIMEOUT_MS: '2000',
  MOCK_CRASH_DELAY_MS: '15',          // mock child lifetime before crash
  SUPERVISOR_ESCALATION_OBSERVER: '1',
  SUPERVISOR_CHILD_SCRIPT: MOCK_CRASHING_SERVER,
};

function spawnSupervisor(extraEnv) {
  const env = { ...process.env, ...SHRUNK_ENV, ...(extraEnv || {}) };
  // detached:true (POSIX) so we can kill the whole process group on cleanup
  // — same pattern as test/supervisor-integration.test.js.
  return spawn(process.execPath, [SUPERVISOR_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    detached: process.platform !== 'win32',
    env,
  });
}

function collectEscalations(proc) {
  const escalations = [];
  proc.on('message', (msg) => {
    if (msg && msg.type === 'supervisor_escalation') {
      escalations.push({ tier: msg.tier, count: msg.count, windowMs: msg.windowMs, delayMs: msg.delayMs, at: Date.now() });
    }
  });
  return escalations;
}

function collectStdio(proc) {
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });
  return { get text() { return out; } };
}

async function stopSupervisor(proc) {
  if (!proc || proc.killed) return;
  try {
    if (proc.connected) proc.send({ type: 'shutdown' }, () => { /* swallow */ });
  } catch (_) { /* ignore sync errors */ }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') {
          require('child_process').execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' });
        } else {
          process.kill(-proc.pid, 'SIGKILL');
        }
      } catch (_) { /* already dead */ }
      resolve();
    }, 3000);
    proc.on('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEscalation(escalations, tier, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (escalations.some((e) => e.tier === tier)) return true;
    await sleep(25);
  }
  return false;
}

// PROC-01-fixup: wait for ANY tier ≥ minTier. Used by the contract test
// that must tolerate runner-speed-induced tier-1-skip (Windows shared
// hosts where multiple crashes land in one tick → supervisor jumps to
// tier-2 without ever observing tier-1).
async function waitForAnyEscalation(escalations, minTier, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (escalations.some((e) => e.tier >= minTier)) return true;
    await sleep(25);
  }
  return false;
}

describe('PROC-01: supervisor circuit-breaker tiered escalation', function () {
  this.timeout(20000);

  describe('Escalation contract (monotonic + supervisor alive + loud log)', function () {
    let proc, escalations, stdio;

    afterEach(async function () { await stopSupervisor(proc); });

    // PROC-01-fixup (test-the-contract-not-the-proxy): the original
    // assertion was "observe tier-1 escalation within 4s." On slow CI
    // runners (notably Windows shared GitHub Actions hosts), multiple
    // crashes can land inside the same monitor tick — the supervisor
    // jumps directly to tier-2, skipping tier-1 entirely. Observed
    // Windows transcript: tier:0 → tier:2(count=5). The "transit
    // tier-1 specifically" assertion was a proxy that depended on
    // crash-spacing-vs-runner-speed, not on the algorithm.
    //
    // The supervisor's actual contract is:
    //   1. Tiers escalate monotonically (never regress, e.g. 2 → 1).
    //   2. The supervisor never permanently exits on a crash sequence.
    //   3. At least one escalation (tier ≥ 1) fires under sustained
    //      crash pressure — escalation isn't dead code.
    //   4. The loud "TIER N ESCALATION" log appears for operator
    //      visibility.
    // All four are CI-environment-invariant: whether the runner is
    // fast enough to transit tier-1 or only ever observes tier-2,
    // every contract still holds. Mirrors SUP-HOT's HOT-04-fixup
    // pattern — see docs/history/stability-hardening-2026-sup-hot.md
    // §"Test the contract, not the proxy".
    it('escalates monotonically, stays alive, fires tier-≥1 with loud log', async function () {
      proc = spawnSupervisor();
      escalations = collectEscalations(proc);
      stdio = collectStdio(proc);

      // Wait until ANY escalation (tier ≥ 1) is observed. The previous
      // version polled specifically for tier-1, which Windows can skip
      // when crashes pile up faster than the monitor tick.
      const sawEscalation = await waitForAnyEscalation(escalations, 1, 4000);

      // ---- Contract 3: some escalation actually fires ----
      assert.ok(
        sawEscalation,
        `expected at least one tier-≥1 escalation within 4s — observed: ${JSON.stringify(escalations)}`
      );

      // ---- Contract 1: tiers escalate monotonically ----
      // The supervisor must never down-shift a tier inside a single
      // crash sequence. tier:0 → 1 → 2 OK; tier:2 → 1 NOT OK.
      const tiers = escalations.map((e) => e.tier);
      for (let i = 1; i < tiers.length; i++) {
        assert.ok(
          tiers[i] >= tiers[i - 1],
          `tier regressed at index ${i}: ${tiers[i - 1]} → ${tiers[i]} ` +
          `(full sequence: ${tiers.join(',')})`
        );
      }

      // ---- Contract 2: supervisor never permanently exits ----
      // The KEY assertion — the pre-fix supervisor would have exited(1)
      // by now. The user-facing promise of the daemon is that the
      // browser ALWAYS has something to talk to.
      assert.strictEqual(proc.killed, false, 'supervisor must NOT be killed on crash sequence');
      assert.strictEqual(proc.exitCode, null, 'supervisor must NOT have exited on crash sequence');

      // ---- Contract 4: the loud log fires for operator visibility ----
      // Match any tier ("TIER 1 ESCALATION" or "TIER 2 ESCALATION").
      // Specific-tier matching would re-introduce the same runner-speed
      // sensitivity the rest of the test eliminates.
      assert.ok(
        /TIER [12] ESCALATION/.test(stdio.text),
        'expected stderr to include "TIER {1,2} ESCALATION" loud log — see proc-supervisor-breaker.md'
      );
    });
  });

  describe('Tier 2 (sustained slow churn, 5 in 1h window — shrunk to 2s)', function () {
    let proc, escalations, stdio;

    afterEach(async function () { await stopSupervisor(proc); });

    it('triggers tier-2 escalation, queues an IPC supervisor_warning, and stays alive forever', async function () {
      proc = spawnSupervisor();
      escalations = collectEscalations(proc);
      stdio = collectStdio(proc);

      // First three crashes will trip tier 1 (within 200ms window).
      // After tier 1, restart delay is 120ms. Two more crashes after that
      // will accumulate to 5 within the 2s sustained window → tier 2.
      const gotTier2 = await waitForEscalation(escalations, 2, 6000);

      assert.ok(gotTier2, `expected tier-2 escalation within 6s — observed: ${JSON.stringify(escalations)}`);

      const tier2 = escalations.find((e) => e.tier === 2);
      assert.ok(tier2.count >= 5, `tier-2 count should be ≥ 5 in the sustained window (got ${tier2.count})`);
      assert.strictEqual(tier2.delayMs, 240, 'tier-2 should set restart delay to TIER2_RESTART_DELAY_MS (240 in test env)');

      assert.strictEqual(proc.killed, false, 'supervisor must NOT be killed after tier-2 escalation');
      assert.strictEqual(proc.exitCode, null, 'supervisor must NOT have exited after tier-2 escalation');

      assert.ok(
        /TIER 2 ESCALATION/.test(stdio.text),
        'expected stderr to include "TIER 2 ESCALATION" loud log'
      );

      // IPC supervisor_warning should be queued for the next child. Wait
      // a tier-2 delay (240ms) + spawn time so the next child gets it,
      // and that child's mock-warning echo lands on stdout.
      await sleep(500);
      assert.ok(
        /\[mock-warning\] .*"tier":2/.test(stdio.text),
        `expected the next child to receive supervisor_warning tier=2 — stdio: ${stdio.text.slice(-1000)}`
      );
    });
  });

  describe('Never-give-up invariant', function () {
    let proc, escalations, stdio;

    afterEach(async function () { await stopSupervisor(proc); });

    it('keeps respawning even after sustained tier-2 churn (no permanent exit)', async function () {
      proc = spawnSupervisor();
      escalations = collectEscalations(proc);
      stdio = collectStdio(proc);

      // Drive enough wall time to put well past the 5-crash threshold.
      // Even at tier-2 cadence (240ms) we'll see additional crashes;
      // the invariant is that the supervisor stays alive throughout.
      await sleep(3000);

      assert.ok(escalations.some((e) => e.tier === 2), 'should have escalated to tier 2 within 3s');
      assert.strictEqual(proc.killed, false, 'supervisor still alive after sustained churn');
      assert.strictEqual(proc.exitCode, null, 'supervisor never called process.exit(1)');

      // Count crashes — should be many (≥ 5). The exact count varies with
      // CI timing; the test asserts the lower bound only.
      const exitMentions = (stdio.text.match(/exited unexpectedly/g) || []).length;
      assert.ok(exitMentions >= 5, `expected ≥ 5 "exited unexpectedly" log entries (got ${exitMentions})`);
    });
  });

  describe('Below-threshold quiet (sanity check the breaker does NOT misfire)', function () {
    let proc, escalations;

    afterEach(async function () { await stopSupervisor(proc); });

    it('does not escalate when only 2 crashes occur in the tight window', async function () {
      // To get exactly 2 crashes we'd need a fixture that crashes the
      // first two times and then exits cleanly. Use a small wrapper here
      // by setting CRASH_DELAY high enough that the test ends before a
      // third crash could land. With CIRCUIT_BREAKER_WINDOW_MS=200,
      // CRASH_RESTART_DELAY=20, child lifetime 15ms → ~35ms/cycle, so
      // we'll see ~6 crashes in 200ms — too many.  Instead, drive 2
      // crashes and immediately shut down before tier-1 fires.

      // Use a 90ms mock child lifetime so we get ~2 crashes in 250ms,
      // then shut down. Tier 1 (3 crashes) would need ≥ 3 × ~(90+20)ms
      // = 330ms — so 250ms gives us 2 crashes, no escalation.
      proc = spawnSupervisor({ MOCK_CRASH_DELAY_MS: '90' });
      escalations = collectEscalations(proc);

      await sleep(250);

      // The observer fires on every classification including tier 0
      // (no-escalation). Filter to actual escalations only.
      const realEscalations = escalations.filter((e) => e.tier > 0);
      assert.strictEqual(
        realEscalations.length, 0,
        `no escalation expected with 2 crashes < threshold (3); got: ${JSON.stringify(realEscalations)}`
      );
      assert.strictEqual(proc.killed, false, 'supervisor should not have exited');
    });
  });
});
