# PR Body: Supervisor Retention Diagnosis

## Scope and evidence

This is a **diagnose-only** change. It adds content-free retention counters to
`GET /api/diagnostics`, a paired V8 heap-snapshot mode to the existing soak
harness, an isolated output-buffer flood workload, and proving probes. It
does not trim buffers, expire sessions, alter process lifecycle, or change any
production retention policy.

The primary isolated artifact was captured with:

```sh
node test/longevity/harness/cli.js \
  --duration=8s --interval=1s --workloads=output-buffer-flood \
  --gates=memory --heap-snapshots \
  --out=/tmp/ai-or-die-retention-output-20260801 --json
```

The intentionally saturated test failed the memory gate: **11,750.879 MB/h**
over 10 samples (the production threshold is 2.5 MB/h). That is not a
production forecast: the workload writes 4 MiB/s to make the retaining path
observable in seconds. Its final diagnostic measured **30,867,456 bytes
(29.4 MiB)** in four inactive session buffers. V8 recorded
`string +30,894,800` shallow bytes; its same-run retained-object path was:

```text
OutputBufferFloodWorkload -> ClaudeCodeWebServer._server
  -> claudeSessions Map -> Session -> outputBuffer -> CircularBuffer
```

`heap-diff.json` reports aggregate constructor deltas. The companion
`test/longevity/process/heap-snapshot-retainers.test.js` proves attribution
without treating a representative constructor path as a delta identity: its
baseline has no session `CircularBuffer`, then it finds a non-weak end-snapshot
path requiring both `claudeSessions` and `outputBuffer`.

## Ranked root causes

| Rank | Severity | Exact location | Retainer chain / measured growth | Reproduction |
|---|---|---|---|---|
| 1 | **Critical** | `src/base-bridge.js:404-413`; `src/server.js:4807,5492`; `src/utils/circular-buffer.js:18-29` | `claudeSessions -> Session -> outputBuffer -> CircularBuffer.buffer[] -> String`. `CircularBuffer(1000)` caps items, not bytes. The server sink retained **1,000 x 64 KiB = 62.5 MiB/session** in the chosen probe, but there is **no maximum byte bound**; the persistence-only cap is 512 KiB. | `npx mocha --exit --timeout 180000 test/longevity/process/supervisor-retention-probes.test.js`; isolated soak above |
| 2 | **Critical** | `src/server.js:5515-5532,6493-6585` | PTY exit only marks the Session inactive; `claudeSessions` remains the root until the seven-day sweep. Eight newly exited sessions held **2,097,152 bytes** unchanged after a sweep; a full buffer retains up to **62.5 MiB for each dead session**. | `npx mocha --exit --timeout 180000 test/longevity/process/supervisor-retention-probes.test.js` |
| 3 | **Important** | `src/artifact-review.js:187-190,321-338,454-488` | `ClaudeCodeWebServer.artifactReviews -> _reviews Map -> ended Review -> domSnapshot/chat`. `end()` changes status but never removes the Map entry; chat is independent of the 200-event replay cap. One ended review retained **>=512 KiB** of DOM snapshot plus **>1 MiB** of chat text. | `npx mocha --exit test/longevity/process/supervisor-retention-probes.test.js` |
| 4 | **Important, conditional** | `src/sticky-note-summarizer.js:80-92,164-188,316-360` | `StickyNoteSummarizer._states -> state.pendingText`. JSONL turns append until successful inference consumes the prefix. An unavailable engine left **>=2,097,183 bytes** after 32 x 64 KiB turns. | `npx mocha --exit test/longevity/process/supervisor-retention-probes.test.js` |
| 5 | **Important, conditional** | `src/vscode-tunnel.js:634,645-651` | `VSCodeTunnelManager.tunnels -> Tunnel.serverProcess.stdout data listener -> outputBuffer`. The readiness listener keeps concatenating stdout after readiness for the full `code serve-web` lifetime. The probe kept **>1 MiB** of post-ready stdout in one active tunnel; five tunnels can do this independently. | `npx mocha --exit test/longevity/process/vscode-output-retention.test.js` |
| 6 | **Minor, permanent cardinality** | `src/server.js:4440-4452,6583-6587`; `src/control/event-bus.js:73-75,95-118` | `ClaudeCodeWebServer._controlSessionSeq` has no parent-session cleanup. Separately, `ControlEventBus._evictedBySession` retains a watermark for every evicted ring although `_buckets` caps payload rings. One evicted parent left its sequence entry; 256 distinct sessions with a one-ring cap left **255 watermarks** while retaining one event bucket. | `npx mocha --exit test/longevity/process/supervisor-retention-probes.test.js` |
| 7 | **Minor, permanent after delete** | `src/terminal-bridge.js:188-203,217-235`; `src/claude-bridge.js:65,135-146`; `src/base-bridge.js:418-441`; `src/server.js:1523-1531` | Natural BaseBridge exit removes `BaseBridge.sessions`, but does not invoke subclass cleanup. The DELETE route calls `bridge.stopSession()` only for active sessions, so inactive terminal OSC7 maps and Claude trust entries survive deletion. Three natural exits left **three entries in each affected map**; the real DELETE probe left terminal maps reachable after the parent was gone. | `npx mocha --exit test/longevity/process/supervisor-retention-probes.test.js` |
| 8 | **Minor** | `src/server.js:7325-7363`; `src/usage-analytics.js:63,116-132,477-491` | `UsageAnalytics.activeSessions` is written by every distinct `get_usage` session ID. The only expiry routine exists but the server path never calls it. **256** queried IDs created 256 live entries; `historicalData` remained zero. | `npx mocha --exit test/longevity/process/supervisor-retention-probes.test.js` |

### 1. Live output is byte-unbounded, not “last 1000 lines”

`BaseBridge` forwards arbitrary coalesced PTY bytes as one callback argument.
The two supervisor sinks push that callback as one `CircularBuffer` item, so
“1,000 lines” is neither a line nor byte limit on Windows ConPTY or POSIX
PTYs. The new real-PTY probe streams 1 MiB of newline-free output through
`BaseBridge`; the server-sink probe chooses 1,000 x 64 KiB inputs to demonstrate
62.5 MiB, not a maximum. A single larger raw/coalesced batch makes the live
retention arbitrarily larger.
`SessionStore._capBufferByBytes` only runs while serialising disk state
(`src/utils/session-store.js:80-90,212-213`) and cannot release the live
strings. **Recommended fix:** use one byte-accounted live scrollback
representation that splits at safe output boundaries or evicts whole chunks
until both item and byte limits hold; reconnect replay must consume that same
bounded representation. This PR does not implement it.

### 2. Dead-session amplification

The raw scrollback survives a PTY exit, a WebSocket disconnect, and a stop
until user deletion or the seven-day inactivity policy. This converts finding
1 into a multi-day accumulation of strong `claudeSessions` roots. **Recommended
fix:** preserve a deliberately small post-exit screen snapshot or replay
window, shrink raw scrollback at process exit, and use an explicit aggregate
memory budget rather than relying on the disk serialisation cap. This PR does
not change lifecycle behavior.

### 3. Artifact reviews are permanent process roots

`ArtifactReviewStore.end()` is semantic completion, not memory completion.
It leaves the review keyed in `_reviews`, retaining the last DOM snapshot and
an unbounded duplicate chat log even though replay events are capped. **Recommended
fix:** bound review-chat/snapshot bytes, expire ended reviews after a reconnect
grace period, and delete the review when its parent session is deleted. This
PR only exposes the review counts and byte totals.

### 4. Sticky JSONL pending text has no failure-mode budget

Expand-gating prevents collapsed cards from normally entering this path, but
once clean JSONL turns are fed to an enabled summarizer, unavailable/failed
inference leaves `needsSummary` and `pendingText` intact. More external input
then appends indefinitely. **Recommended fix:** bound pending text by bytes,
keep a recent-turn window with a truncation marker, and advance/discard the
unusable prefix when the engine is permanently unavailable. No summary behavior
changes here.

### 5. VS Code Server stdout is retained after readiness

`_spawnServer()` needs only enough stdout to detect readiness, but its
`outputBuffer` continues to concatenate every future stdout chunk in a listener
that lives with the `code serve-web` child. This is independent of terminal
scrollback and therefore matters when the optional web editor is enabled.
`_serverOutputBytes` is reset when the child exits, so it measures only the
currently live closure; it is instrumentation, not a cap. **Recommended fix:**
discard the readiness buffer once ready (or retain a
small rolling diagnostic tail), bound login parsing similarly, and expose only
counter/tail metadata. This PR deliberately does not trim it.

### 6. Control-plane scalar maps never forget retired session IDs

`_controlSessionSeq` lacks a delete on manual deletion and eviction. The
event bus correctly bounds each event ring and total retained rings, but its
filter-overflow watermark map is not co-evicted. These are low-byte entries,
but each created session remains represented for the supervisor lifetime.
**Recommended fix:** delete session-sequence entries with the parent session
and bound/TTL `_evictedBySession` according to the maximum cursor-resume
window, preserving a documented global overflow fallback for expired
watermarks. No control-plane semantics are changed in this PR.

### 7. Natural PTY exits bypass subclass-owned state cleanup

`BaseBridge` disposes PTY listeners and deletes its own session record on
natural exit, but `TerminalBridge.stopSession()` is the only place that clears
its OSC7 maps and `ClaudeBridge.stopSession()` is the only place that clears
the trust guard. Worse, the DELETE route skips `bridge.stopSession()` when the
session is already inactive, so manual deletion removes the parent without
clearing those subclass maps. **Recommended fix:** add a BaseBridge subclass
exit-cleanup hook and invoke it from natural exit/error/watchdog paths and
unconditionally from parent-session deletion. This PR only proves and counts
the entries.

### 8. Usage analytics does not invoke its own expiry

The process-wide analytics `activeSessions` map is repopulated by the usage
WebSocket route. Its `cleanup()` method exists, but this route never calls it;
the probe shows one entry per queried ID. `historicalData` is not populated by
the production path. **Recommended fix:** invoke `cleanup()` around usage
updates and add a defensive map capacity. This is small beside terminal
scrollback but monotonic over long service lifetimes.

## Checked and ruled out as primary multi-day retainers

| Surface | Evidence | Verdict |
|---|---|---|
| SessionStore disk buffers and 30-second autosave | `SessionStore._capBufferByBytes` applies 512 KiB per session during persistence; `test/session-store.test.js` passes. Historic soak data reports `save_failure_count: 0`. | **Not the live-heap root.** It can cause temporary allocation/CPU pressure and has no global session-count cap, but it does not retain the large live buffer. |
| `UsageReader.readAllEntries()` | A **4.99 MiB** synthetic JSONL fixture produces 12,000 temporary extracted objects. The all-time path does not assign the array to the five-second `cache`. | **Transient peak/CPU cost, not a persistent raw-entry leak.** Stream aggregation remains advisable. |
| `UsageAnalytics.historicalData` | The production-path probe reports `historical_data: 0` after 256 calls. | **Ruled out.** Finding 8 identifies the actual analytics cardinality. |
| PTY listeners, child processes, and Windows Job Objects | `test/pty-listener-disposal.test.js` covers stop, natural exit, errors, and temporary exit waiters. `test/longevity/process/windows-handle-probe.test.js` runs 20 real ConPTY create/exit cycles on Windows and fails if `HandleCount` rises by more than five. | **Ruled out for the current JS/handle path.** The Windows probe is intentionally skipped off Windows. |
| WebSocket listener/maps/heartbeat | `test/longevity/process/ws-listener-cleanup.test.js` proves all `message`, `close`, and `error` listeners are zero immediately after cleanup; diagnostics samples listener counts and `bufferedAmount`. | **Ruled out.** Reconnect storms do not retain stale socket entries on the tested path. |
| `fs.watch` / chokidar tailers | `test/fs-watch-cleanup.test.js` covers DELETE, eviction, close, and idempotent cleanup. Sticky JSONL reads at most 512 KiB per call; `_claudeNotes` and offsets are capped at 300. | **Ruled out**, except sticky `pendingText` in finding 4. |
| Mesh, app tunnel, keep-awake, and VS Code restart loops | Mesh bounds newline-less stdout at 256 KiB; tunnel/VS Code restart probes cover capped backoff and cleanup; mesh and keep-awake tests clear their timers/helpers. | **No stacking child/timer loop found.** Finding 5 is the separate VS Code stdout-string retainer. |
| Server intervals and per-event timer rearming | Diagnostics now reports known server/session/sticky timer counts. Server shutdown clears its intervals; existing lifecycle suites cover tunnel/worker timer teardown. | **No unbounded stacking path found.** A transient STT restart delay is bounded by its 15-second cap. |
| Process-level shutdown listeners | `src/server.js:427-448` attaches shutdown/error listeners per `ClaudeCodeWebServer` construction and does not remove them on `close()`. The new `process.listener_counts` field exposes this; the longevity test process reports `MaxListenersExceededWarning` only because it constructs many independent servers. | **Not the singleton supervisor root:** production restart forks a new server process. It is a leaky reusable-server API/test-harness path and should be fixed if in-process server replacement is supported. |
| HTTP rate-limit maps and streaming responses | Server IP/session rate buckets cap at 10,000 entries; control-router identities cap at 2,000 and expire. The legacy `AuthManager` has hourly cleanup but no cardinality cap and is not the active server auth path. | **Bounded normal operation; potential short-lived hostile-cardinality pressure, not the observed multi-day growth.** |
| Worker request queues and MessagePorts | Sticky/STT queues cap at three; worker respawn suites assert old worker references/listeners are dropped and shutdown does not respawn. | **No main-thread JS retainer found.** |

## Native RSS, fragmentation, and Windows conclusion

The isolated output-buffer soak grew JS heap while `external_mb` stayed at
**3.9 MB** and `array_buffers_mb` at **0.1 MB**. The paired snapshot names
strings and the `claudeSessions -> outputBuffer` path, so this reproduction is
not node-pty native memory, a Buffer/ArrayBuffer leak, or V8 fragmentation.
No `--max-old-space-size` setting changes that retaining path; it changes only
when V8 aborts.

`node-llama-cpp` and sherpa model residency remain native/worker RSS, so a
main-thread V8 snapshot cannot attribute model weight pages. The new
diagnostics expose RSS versus heap/external/ArrayBuffer, worker status, queue
length, live/spawning state, restart attempts, active libuv-handle types,
Linux FDs, and Windows `Get-Process HandleCount`. `CircularBuffer` maintains
the output byte metric incrementally; sticky/review metrics are five-second
samples, and the Windows handle sample is an asynchronous, minute-cached
PowerShell result, so diagnostics cannot rescan all PTY output or synchronously
block the service per request. The worker lifecycle tests rule out
message-port/listener/respawn stacking in the supervisor; they
do **not** claim a loaded 1.56 GB model is leak-free. A Windows sticky-note
soak with the real model enabled is required to close that native-RSS-only
question.

## Verification commands

```sh
npx mocha --exit --timeout 180000 test/longevity/process/supervisor-retention-probes.test.js
npx mocha --exit --timeout 180000 test/longevity/process/heap-snapshot-retainers.test.js
npx mocha --exit test/longevity/process/vscode-output-retention.test.js
npx mocha --exit test/pty-listener-disposal.test.js \
  test/longevity/process/ws-listener-cleanup.test.js \
  test/fs-watch-cleanup.test.js test/session-store.test.js
npm run test:longevity:server
```
