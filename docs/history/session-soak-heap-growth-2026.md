# Session soak heap-growth measurements (2026-08-05)

## Scope

This investigation measured two separate effects:

1. post-GC heap retained as the server's session map grows; and
2. transient heap pressure while `sessions.json` is serialized and written.

It did not add session admission, capacity, or eviction behavior.

Raw artifacts are preserved under
`test/longevity/results/session-memory-final/`. That directory is intentionally
gitignored. Each arm contains `metadata.json`, `samples.jsonl`, and
`summary.json`.

## Environment and method

The runs used Linux x64 under WSL2
(`6.6.87.2-microsoft-standard-WSL2`), Node `v24.18.0`, and 16 logical CPUs.
Windows and macOS were not measured.

The retention A/B used three fresh processes per arm. Each process created
28,320 sessions through `POST /api/sessions/create` during 480 active seconds:
59 sessions per active second, with one quiescent sample every 30 active
seconds. Wall-clock duration was 487.850-488.159 seconds for persistence on and
482.563-482.705 seconds for persistence off, equivalent to measured end-to-end
rates of 58.014-58.051 and 58.669-58.687 sessions/second respectively.

Every session name contained a deterministic, distinct 1,024-byte payload.
The probe generated and SHA-256 checked all 28,320 payloads before each arm.
Each of the 17 samples per repetition paused creation, drained the save queue,
ran four explicit full-GC passes, and then recorded `heapUsed`. Per-session
marginal retention is the least-squares slope over those 17 post-GC samples,
not a subtraction between two heap readings.

Persistence-off replaced only that server instance's
`sessionStore.saveSessions` method with a no-write implementation. The server,
HTTP route, session map, payload generation, sampling cadence, and process
remained otherwise identical.

The stringify phase covered the complete `_serializeDataStreamed` call. The
write phase started at the temporary file's `writeFile` call and ended after
its `sync` call, so the reported write duration includes the file fsync. Phase
heap was sampled every 5 ms and once at each phase boundary.

## Retained heap

| Arm | Repetition slopes (bytes/session) | Mean | Sample SD | Min-max | R-squared |
|-----|-----------------------------------:|-----:|----------:|--------:|-----------|
| persistence on | 18,048.725; 18,046.933; 18,048.941 | 18,048.200 | 1.102 | 18,046.933-18,048.941 | 0.999997079-0.999997204 |
| persistence off | 18,044.404; 18,042.374; 18,041.698 | 18,042.826 | 1.408 | 18,041.698-18,044.404 | 0.999993708-0.999993751 |

The persistence-on minus persistence-off regression slope was 5.374
bytes/session, 0.0298% of the persistence-on slope. The endpoint estimator
reversed that direction: baseline-to-final growth averaged 18,060.012
bytes/session with persistence and 18,063.043 bytes/session without it, a
3.031-byte/session difference in the opposite direction. The matrix therefore
did not resolve a non-zero persistence contribution to retained heap. At
exactly 59 sessions/second, the regression slopes correspond to 60.931
MiB/minute with persistence and 60.913 MiB/minute without it.

Across the six repetitions, baseline post-GC heap was
12,544,024-12,572,440 bytes and final post-GC heap at 28,320 sessions was
523,998,584-524,127,440 bytes. The near-unit R-squared values and the matching
persistence-off curve show that the live set grew linearly and did not flatten
after forced GC.

These marginal sizes apply to the measured session shape, including the unique
1,024-byte name and the in-process harness. The run did not measure a
zero-payload session, so it cannot split the 18,043-18,048 bytes into session
overhead versus the known payload without introducing a subtraction estimate.

## Persistence pressure and overlap

The persistence-on repetitions wrote a final `sessions.json` of 45,113,827
bytes. They performed 498, 493, and 498 measured serialization/write cycles.
Peak queued `saveSessions` callers were 59, 235, and 59. Observed simultaneous
writes were zero in all three repetitions.

Even without write overlap, absolute heap occupancy during measured persistence
phases was material:

| Repetition | Maximum phase heap (bytes) | Post-GC heap at that sample (bytes) | JSON bytes at that sample |
|------------|---------------------------:|------------------------------------:|--------------------------:|
| 1 | 2,028,338,000 | 524,034,464 | 45,113,827 |
| 2 | 1,771,438,784 | 460,383,256 | 39,474,607 |
| 3 | 1,888,142,744 | 460,434,984 | 39,474,607 |

The maximum per-repetition stringify duration was 390.932, 438.998, and
386.047 ms. The maximum write duration was 330.128, 2,941.659, and 287.098 ms.
These phase peaks include ambient uncollected request and session-creation
garbage; they are not an estimate of serialization allocation. Their
non-monotonic relationship to JSON size confirms that limitation: repetitions
2 and 3 peaked at 24,780 sessions and a 39,474,607-byte JSON file rather than
at their final 28,320 sessions and 45,113,827-byte file. The fixed-population
arm below isolates persistence pressure.

## Fixed-population serialization arm

The fixed-population arm created 17,900 sessions with distinct 12,500-byte
names while persistence was disabled, then held the population constant for
four full saves. SHA-256 checks covered all 17,900 payloads. The resulting
`sessions.json` was 233,935,167 bytes (223.098 MiB).

Post-GC heap before the first save was 543,249,952 bytes. Post-GC readings after
the four saves were 541,861,408; 541,028,792; 541,039,112; and 541,056,456
bytes. The final reading was 2,193,496 bytes below the pre-save reading, so the
four serializations left no measured positive retained residue.

Stringify durations were 759.538-1,279.980 ms (mean 925.171 ms, sample SD
240.276 ms). Write durations were 1,774.577-2,047.181 ms (mean 1,913.076 ms,
sample SD 119.407 ms). No queued save caller and no overlapping write was
observed in this arm.

The maximum phase heap was 1,024,102,576 bytes, 480,852,624 bytes
(458.577 MiB) above the fixed-population pre-save post-GC heap.

## Deletion arm

The persistence-off deletion arm started at 12,601,256 bytes post-GC, reached
524,125,424 bytes with 28,320 sessions, deleted every session through
`DELETE /api/sessions/:sessionId`, and ended at 20,236,440 bytes post-GC.
Of the measured 511,524,168-byte growth, 503,888,984 bytes (98.5074%) was
reclaimed. The residual above baseline was 7,635,184 bytes (7.281 MiB).

## Conclusion

**Steady-state growth is retained session state, not persistence garbage.**
Persistence-on and persistence-off regression slopes differed by 5.374
bytes/session while the endpoint estimator differed by 3.031 bytes/session in
the opposite direction. The fixed 233,935,167-byte JSON population left no
positive post-GC residue after four saves. The server's retained per-session
graph therefore dominates monotonic live-heap growth in this workload; this
matrix did not resolve a retained-heap contribution from persistence.

**Serialization is a large transient and can plausibly be the final allocation
that reaches the heap limit, but it is not the monotonic driver.** At fixed
population it raised phase heap by 480,852,624 bytes. No run in this matrix
exited with code 134, so the measurement establishes the pressure, not that
serialization alone reproduces the production abort.

## Measurement limits

- Windows 11 and macOS were not exercised; filesystem timing and phase peaks on
  those platforms remain unmeasured.
- The server and harness shared one process and one heap. Absolute slopes
  include harness retention; the persistence A/B delta cancels the shared
  harness because both arms used the same code and sample shape.
- The earlier shared-string large-JSON confound was removed: this matrix used
  28,320 distinct 1,024-byte payloads per retention arm and 17,900 distinct
  12,500-byte payloads in the serialization arm. V8's internal string
  deduplication was not separately measured.
- Phase heap was sampled every 5 ms. A shorter spike could have been missed, so
  recorded phase peaks are lower bounds.
- Queue depth counts concurrent `saveSessions` callers, including callers that
  may take the store's clean fast path after reaching the serialized queue.
- The final matrix metadata did not record V8's heap-size limit, so no
  percentage-of-limit claim is made.
- The run did not collect heap snapshots or dominator-tree retained sizes.
  Reclaimability was measured by the deletion arm instead.
- The 8-minute arms and four-save fixed-population arm did not reproduce exit
  code 134; behavior at the previously observed multi-hour heap size remains
  unmeasured here.
