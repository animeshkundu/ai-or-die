'use strict';

// test/fixtures/mock-crashing-server.js
//
// PROC-01 regression fixture: a supervised child that crashes immediately
// on start with a non-zero exit code, so the supervisor's circuit-breaker
// logic gets driven through its tiered escalation path.
//
// Behaviour:
//   - Exits with code 42 (any non-zero, not 75/RESTART_EXIT_CODE) after a
//     short delay.
//   - Respects IPC { type: 'shutdown' } by exiting cleanly with code 0
//     (clean shutdown short-circuits the breaker — tests use this to stop
//     the supervisor cleanly at end-of-run).
//   - Echoes any supervisor_warning IPC message it receives onto its
//     stdout as a JSON line prefixed `[mock-warning] {...}` so the test
//     can assert IPC delivery without poking at the supervisor's
//     internals.

const CRASH_DELAY_MS = parseInt(process.env.MOCK_CRASH_DELAY_MS, 10) || 30;

if (typeof process.send === 'function') {
  process.on('message', (msg) => {
    if (msg && msg.type === 'shutdown') {
      process.exit(0);
    }
    if (msg && msg.type === 'supervisor_warning') {
      // Surface the warning so the test can grep for it.
      try {
        process.stdout.write('[mock-warning] ' + JSON.stringify(msg) + '\n');
      } catch (_) { /* ignore */ }
    }
  });
}

setTimeout(() => {
  // Synthesize an "always crashes" daemon. Exit code 42 is arbitrary —
  // any non-zero that isn't RESTART_EXIT_CODE (75) gets counted as a
  // crash by the supervisor.
  process.exit(42);
}, CRASH_DELAY_MS);
