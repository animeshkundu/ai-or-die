# Diagnose supervisor-process memory retention under continuous agentic load

## Scope and evidence standard

This PR is **diagnosis only**. It adds default-off instrumentation, process-isolated
probes, a streaming dominator analyzer, passing lifecycle tests, and opt-in
expected-red characterizations. It intentionally does not cap, evict, truncate,
restart, or otherwise fix any retained structure.

All source locations below are pinned to reproduced base commit
`4c181ef76639e7640717c31b3f4bc324f98a6d36`. Fresh measurements used Node
`v22.23.2`, Linux x64, two explicit full GCs per sample, three fresh-process
repeats, a separate zero-workload control for each repeat, and separate
supervisor/server PIDs. Windows is the primary deployment target; the new opt-in
workflow treats `windows-latest` as the gate and also runs Ubuntu, but
`windows-latest` is Windows Server rather than Windows 11. Model-backed,
multi-hour, and real-operator-rate arms still require a Windows 11 self-hosted
runner.

Raw derived series are in `test/longevity/results/derived/`. No real heap
snapshot is committed or uploaded. The one captured snapshot was synthetic-only,
13,023,118 bytes, SHA-256
`29448a036fa4a6c89b1f6772f41b7e964ff31d4ff596f62941063106ebfb5b20`,
parsed locally, and deleted; only redacted dominator aggregates remain.

### Historical failure reproduced by CI

Scheduled run
[`30735375519`](https://github.com/animeshkundu/ai-or-die/actions/runs/30735375519)
at this base commit died with V8
`FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`
on all three OSes: Windows job `91463116736` after 2h23m, Ubuntu job
`91463116700` after 2h19m, and macOS job `91463116718` after 1h06m. Windows
heap used grew 45.4 -> 3904.5 MiB and RSS 102.9 -> 4399.6 MiB, about
1621 MiB/hour. External/ArrayBuffer memory repeatedly collapsed while JS heap
did not. Windows artifact `8830935378`, SHA-256
`b71670951ab556da305b0836c23ba42b3bc32f07c43b7af3654e277f7b31ce3b`,
has samples/events/metadata but no gate result, proving the process died before
evaluation rather than merely failing a threshold.

### Current-PR Windows and Ubuntu confirmation

Opt-in workflow run
[`30777263696`](https://github.com/animeshkundu/ai-or-die/actions/runs/30777263696)
passed every diagnosis step on `windows-latest` and `ubuntu-latest` with Node
`v22.23.1`. Windows artifact `8842526385` has digest
`sha256:c655563d3665ac02d93fa18bf24b7f7b69bceb282a97302403749af108df605b`;
Ubuntu artifact `8842503467` has digest
`sha256:c8d369d2dd471df07e5f22122d6ca6ab896f3d52f780b1cc2312c74b846696f1`.
The redacted JSON from both artifacts is committed under
`test/longevity/results/derived/`.

| Arm | Windows | Ubuntu |
|---|---:|---:|
| Sessions at 1/s | 17,881.87 post-GC bytes/op; 61.11 MiB/h | 17,952.67 bytes/op; 61.57 MiB/h |
| PTY, 10s post-exit | 3,477,496 post-GC heap bytes **plus native handle/process retention** | 2,856,712 heap bytes; no child/handle retention |
| Ended artifact reviews | 27,832.93 post-GC bytes/op | 27,538.53 bytes/op |
| Sticky unavailable | 1,167.84 post-GC bytes/turn | 1,167.68 bytes/turn |
| VS Code stdout | 66,805 post-GC bytes/write | 66,775 bytes/write |
| 100-session dominator | Map retained 847,048 bytes | Map retained 847,160 bytes |

## Ranked findings

The ranking multiplies measured retained cost by a stated workload envelope.
The repository does not contain the affected operator's real creation/output
rates, so no finding is claimed as the production cause solely from synthetic CI.
For orientation, the report models 50-200 newly retained sessions/day and states
feature-dependent findings as zero when that feature is unused.

### 1. Critical / PROVEN on Windows: each exited PTY leaves a ConPTY host and native handles

**Locations:** `src/base-bridge.js:310` creates the node-pty process;
`:418-441` handles natural exit, drains `_ptyDisposables`, disposes the per-PTY
job, and deletes the bridge session; `_disposePtyJob` is at `:693-697`.
Those JavaScript owners all report empty after exit, but the Windows native
process/handle tree remains.

**Retainer/handle chain:** server `node.exe -> node-pty WindowsTerminal/ConPTY
native state -> conhost.exe`, accompanied by three extra active libuv `async`
handles and one extra pipe (one timer disappears, so net libuv growth is +3).
This chain is outside the V8 heap and therefore does not appear in the main heap
snapshot.

**Reproduction (Windows):**

```text
node test/longevity/harness/memory-diagnosis-cli.js \
  --arm=pty --operations=32 --repeats=3 --payload-bytes=65536 \
  --warmup-ms=500 --control-ms=250 --drain-ms=10000 \
  --out=test/longevity/results/derived/pty-windows-latest.json
```

The launcher is a cwd-relative `.cmd` wrapper, matching the production class of
Windows CLI shims (`npx.cmd`, agent `.cmd` launchers), and the process tree is
sampled with `Get-Process` plus `Win32_Process`.

**Measured growth:** ten seconds after the child and PTY exit, every repeat had
`claudeBridge.sessions=0`, listener disposables 0, and job handles 0, but still
had one child `conhost.exe` with 110 handles and about 1.60 MiB private bytes.
The server process handle count was 283 -> 305 (**+22 handles**), active handles
6 -> 8, and libuv total 18 -> 21 (async 3 -> 6, pipe 4 -> 5, timer 2 -> 1).
Server private bytes remained **8.03-9.48 MiB** above baseline. The same
10-second Ubuntu arm had no surviving child, active handles 6 -> 6, libuv
18 -> 17, and server handle count 26 -> 25.

This is one surviving host and +22 server handles per single PTY lifecycle in
the probe. At a stated 50 PTY sessions/day it can add roughly 400-475 MiB of
server private bytes/day plus 1,100 server handles/day, before counting the
separate 1.6 MiB/110-handle `conhost.exe` processes. This can present as memory,
handle, and process exhaustion together on the primary platform.

**Recommended fix (not implemented):** Trace node-pty's Windows native close
path and make PTY retirement await ConPTY host teardown, not only the CLI child
exit. Explicitly close the native terminal/pipe handles, verify the per-PTY Job
Object actually contains the host, and fail the regression unless `conhost.exe`,
server HandleCount, and libuv async/pipe counts return to baseline after each
stop, natural exit, error, delete, and eviction path.

### 2. Critical / PROVEN: live sessions retain byte-uncapped PTY tails after the PTY and client are gone

**Locations:** `src/server.js:5493` appends each delivered PTY batch to the
session buffer; `src/base-bridge.js:407-410` forwards a raw batched string;
`src/utils/circular-buffer.js:13` bounds only the number of entries; and
`src/server.js:5518-5535` marks the session inactive on PTY exit but deliberately
keeps the parent session and buffer for replay. The only normal releases are
explicit delete at `src/server.js:1572` or the seven-day eviction path at
`src/server.js:6585`.

**Retainer chain:** `ClaudeCodeWebServer -> claudeSessions Map -> session ->
outputBuffer (CircularBuffer) -> buffer Array[1000] -> raw PTY strings`. Client
disconnect removes only the connection ID. PTY exit removes bridge listeners and
the PTY wrapper, not the parent session buffer.

**Reproduction:**

```text
npx -y node@22 test/longevity/harness/memory-diagnosis-cli.js \
  --arm=pty --operations=32 --repeats=3 --payload-bytes=65536 \
  --warmup-ms=500 --control-ms=250 --drain-ms=500 \
  --out=test/longevity/results/derived/pty-linux-node22.json
```

This launches the real supervisor and server, then the real Claude bridge and
node-pty through `AIORDIE_CLAUDE_LAUNCHER=node synthetic-agent-output.js`.

**Measured growth:** 32 nominal 64 KiB writes retained exactly 2,097,184 content
bytes in each repeat, split by ConPTY/PTY delivery into 439-468 buffer entries.
After PTY exit and WebSocket disconnect, the Claude bridge had zero sessions,
zero listener disposables, and zero job handles, while the parent session still
owned the full buffer. Control-subtracted post-GC heap grew a median 3,119,336
bytes (min 3,115,608; max 3,119,624), or 97,479.25 bytes per nominal write. Old
space grew about 2.695 MiB; external/ArrayBuffer grew only 0.59-0.62 MiB. Active
handles and libuv handle count changed by zero in the local Linux series; the
separate Windows native retention is Finding 1. The stress-rate MB/hour number
(43,010 median) is deliberately not a production projection; this structure
plateaus only when 1,000 **platform-dependent chunks**, not 1,000 lines or a byte
limit, have arrived.

At the modeled 50-200 newly retained sessions/day, if each exited session has a
2 MiB tail like this probe, the retained content alone is about 100-400 MiB/day
until seven-day eviction. That envelope can reach 0.7-2.8 GiB before the age
window stabilizes, and larger per-session tails scale directly.

**Recommended fix (not implemented):** Give the live replay buffer a strict byte
budget as well as an entry budget, account bytes at append time, and make the
lifecycle policy explicit: either release the buffer on terminal exit after
persisting a smaller replay snapshot, or retain only a byte-capped inactive
snapshot. Keep reconnect behavior, but test the byte ceiling through real PTY
fragmentation on Windows rather than assuming callback chunks equal lines.

### 3. Critical / PROVEN-IN-CI, production rate UNPROVEN: live session count has no count bound and every empty session eagerly reserves 1,000 slots

**Locations:** all creation paths allocate eagerly at `src/server.js:1454`,
`src/server.js:4016`, and `src/server.js:4624`; the backing store is
`new Array(capacity)` at `src/utils/circular-buffer.js:13`. The only eviction
threshold is seven days at `src/server.js:6494`; the sweep exits immediately when
the oldest entry is younger at `src/server.js:6536-6541`. There is no maximum
session count.

**Retainer chain:** `ClaudeCodeWebServer -> claudeSessions Map -> session ->
CircularBuffer -> FixedArray[1000]`, plus the session's Set, Date objects, usage
object, strings, and the lazy-tombstone eviction-heap entries.

**Reproduction:**

```text
npx -y node@22 test/longevity/harness/memory-diagnosis-cli.js \
  --arm=sessions --operations=200 --repeats=3 --rate=0 \
  --warmup-ms=500 --control-ms=250 --drain-ms=500 \
  --out=test/longevity/results/derived/sessions-linux-node22.json
```

**Measured growth:** every repeat ended with exactly 200 sessions, zero client
connections, zero WebSockets, zero output bytes, and **200,000 eager backing
slots**. Control-subtracted post-GC heap grew 2,364,064 bytes median
(2,360,584-2,364,200), or **11,820.32 bytes/session**
(11,802.92-11,821.00). Old space grew about 2.00 MiB while external and
ArrayBuffer changed by only 10 KiB and 8 KiB. Active handles and libuv counts
changed by zero. The supervisor's control-subtracted heap delta was exactly zero.

The 100-session heap snapshot independently found a `Map -> backing array`
dominator retaining 885,856 bytes (8,858.56 bytes/session), corroborated by the
ownership counter showing exactly 100 sessions and 100,000 buffer slots. The
remaining per-operation delta is session metadata, eviction bookkeeping, and
persistence activity.

At 50-200 real new sessions/day, the empty-session floor is only about
0.56-2.25 MiB/day, so it does **not** by itself explain multi-GiB growth. At the
CI reconnect-storm rate of 50 sessions/second it projects to about 2,029
MiB/hour, consistent in order with the historical 1,621 MiB/hour OOM.

**Correction to prior evidence:** the `798,680` peak at
`test/longevity/results/FINAL-BUNDLE.md:46` cannot be used to derive
CircularBuffer bytes/session. `mock-clock-workload.js:94-103` injects synthetic
plain session objects that do not allocate `CircularBuffer`. That earlier
9,446-byte arithmetic is retracted. The valid figure is the fresh,
same-PID/post-GC/counter-correlated 11,820.32 bytes/session above. Total created
and concurrent retained are also now reported separately.

**Recommended fix (not implemented):** Add a count/weight budget independent of
the seven-day TTL, avoid eagerly allocating 1,000 slots for empty sessions, and
define eviction priority for inactive/disconnected sessions. A realistic
production counter should first record sessions created/day and tail bytes/day;
do not tune the cap from the synthetic 50/s reconnect storm.

### 4. Important / PROVEN: ended artifact reviews and three uncapped payload lanes remain in `_reviews`

**Locations:** `src/artifact-review.js:190` creates the lifetime `_reviews` Map;
`:240` inserts; `:327` appends uncapped `queuedPrompts`; `:335-337` retains the
latest arbitrary `domSnapshot`; `:463` appends uncapped `chat`; and `:480-489`
marks a review ended without deleting it. Only `events` is capped, at
`:251-253`.

**Retainer chain:** `ClaudeCodeWebServer -> artifactReviews -> _reviews Map ->
ended review -> queuedPrompts[] / chat[] / domSnapshot / events[]`.

**Reproduction:**

```text
npx -y node@22 test/longevity/harness/memory-diagnosis-cli.js \
  --arm=artifacts --operations=200 --repeats=3 --payload-bytes=4096 \
  --warmup-ms=500 --control-ms=250 --drain-ms=500 \
  --out=test/longevity/results/derived/artifacts-linux-node22.json
```

Each operation opens through the real HTTP router, posts one 4 KiB prompt and
4 KiB DOM snapshot, posts one 4 KiB agent reply, and calls `/end`.

**Measured growth:** every repeat retained 200/200 ended reviews, 200 queued
prompts (821,800 serialized bytes), 200 chat entries (832,600 bytes), 819,200
DOM-snapshot bytes, and 600 bounded replay events. Control-subtracted post-GC
heap grew 3,862,696 bytes median (3,862,664-3,862,696), or **19,313.48
bytes/review**. Old space grew about 3.34 MiB; handles and libuv count changed by
zero. At a stated 100 such reviews/day this shape adds about 1.84 MiB/day; large
DOM snapshots and long reply chats increase it linearly. If artifact review is
unused, contribution is zero.

**Recommended fix (not implemented):** Delete or compact ended reviews after
all SSE/long-poll consumers observe the ended event, impose byte/count limits on
chat, queued prompts, and DOM snapshots, and use a TTL/LRU for abandoned open
reviews. Preserve the bounded replay contract separately from the destructive
prompt queue.

### 5. Important / PROVEN conditionally, deployment activation UNPROVEN: unavailable sticky-note engine strands all future JSONL text

**Locations:** `src/sticky-note-summarizer.js:170` appends every turn to
`pendingText`; `:241-245` returns permanently when engine status is
`unavailable`; and `:321-325` drains text only after successful inference.
`node-llama-cpp` is optional. At the reproduced base commit sticky summaries
were on by default; current main makes them opt-in via `--sticky-notes`, so this
retainer now requires an explicitly enabled deployment whose model/binding is
unavailable.

**Retainer chain:** `ClaudeCodeWebServer -> stickyNoteSummarizer -> _states Map
-> session state -> pendingText rope/string`.

**Reproduction:**

```text
npx -y node@22 test/longevity/harness/component-retainer-probe.js \
  --arm=sticky --operations=100 --payload-bytes=1024 --repeats=3 \
  --out=test/longevity/results/derived/sticky-linux-node22.json
```

**Measured growth:** forcing the real summarizer's engine status to
`unavailable` and feeding 100 x 1 KiB turns retained 102,499 owner-counted bytes
and 111,696 control-subtracted post-GC heap bytes in every repeat:
**1,116.96 heap bytes/turn**. This is retention, not fragmentation, because it
survives two full GCs. At 10 MiB/day of extracted transcript text, the measured
ratio is about 10.91 MiB/day. It contributes nothing when inference succeeds
regularly because the success path drains consumed text. Existing soaks disable
sticky notes, so the affected deployment's engine status remains unmeasured.

**Recommended fix (not implemented):** Bound `pendingText` by bytes/turns even
when inference is unavailable, compact it to a recent window or disable
collection after terminal unavailability, and surface the dropped-byte counter.
Retain enough recent context to resume if the model becomes available.

### 6. Important / PROVEN conditionally: `code serve-web` stdout is retained byte-for-byte for the child lifetime

**Locations:** `src/vscode-tunnel.js:634` initializes `outputBuffer`; `:647`
concatenates every stdout chunk. The string is needed only during readiness
detection but remains captured by the stdout listener after readiness.

**Retainer chain:** `VSCodeTunnelManager -> tunnel -> serverProcess.stdout ->
'data' listener closure -> outputBuffer string`.

**Reproduction:**

```text
npx -y node@22 test/longevity/harness/component-retainer-probe.js \
  --arm=vscode --operations=8 --payload-bytes=65536 --repeats=3 \
  --out=test/longevity/results/derived/vscode-linux-node22.json
```

**Measured growth:** after readiness, eight 64 KiB writes retained 524,331
characters and 528,616 control-subtracted post-GC heap bytes median
(527,912-528,616), **66,077 bytes/write** median (65,989-66,077). At a sustained 1 KiB/s log rate this is about 3.54
MiB/hour. Contribution is zero when VS Code tunnels are unused or the child is
quiet.

**Recommended fix (not implemented):** Stop accumulating after readiness or
replace the string with a small rolling byte window sufficient for URL/error
parsing. Detach or replace readiness-only listeners once the state transition
completes, while leaving bounded diagnostic logging.

### 7. Minor / PROVEN, not material to GiB growth: per-session bookkeeping misses cleanup

**Locations:** `_controlSessionSeq` is created at `src/server.js:242` and written
at `:4442`, but neither explicit delete (`:1508-1580`) nor eviction
(`:6557-6590`) removes it. `ControlEventBus._evictedBySession` is created at
`src/control/event-bus.js:74` and grows at `:131` even when the corresponding
bounded event bucket is later evicted. `UsageAnalytics.activeSessions` is
created at `src/usage-analytics.js:63`; expired entries are removed only by
`cleanup()` at `:477-490`, which the server never calls.

**Retainer chain:** server/event-bus/usage singleton -> small Map -> one scalar
record per historical session/key.

**Measured growth:** ownership probes expose these Map sizes directly. The
session stress did not enter the control or usage paths, so both control counters
stayed zero; deterministic source-path characterization shows one watermark or
sequence slot per exercised session. These scalar records are tens to hundreds
of bytes each, not the 11.8 KiB empty-session floor or multi-MiB output tail, and
cannot explain the observed GiB-scale slope at realistic rates.

**Recommended fix (not implemented):** Delete sequence/watermark entries when
their parent session/bucket is destroyed and invoke usage cleanup on a bounded
cadence. Treat this as hygiene after the byte-heavy retainers, not as the primary
incident fix.

## Persistence and transient amplification

`SessionStore` is not an independent permanent retainer, but it amplifies the
session finding and creates transient churn:

- `src/utils/session-store.js:203` materializes an array of every live session
  for each actual save.
- `:212-213` applies the 1,000-entry/512 KiB cap **only while serializing**; it
  does not cap live memory.
- In the 200-session run, 200 fire-and-forget save calls produced maximum queue
  depths 21/23/19. After drain, pending and active saves were zero. Only
  13-18 saves did real serialization because queued calls rechecked dirty state.
  Last JSON sizes were 110,587-119,557 bytes and last save durations 26-29 ms.

Status: **RULED OUT as an independent permanent leak; IMPORTANT transient
amplifier and persistence mirror of Finding 3.** A persistence-on/off arm remains
useful at production tail sizes because one active serialization simultaneously
owns the sessions array, per-session parts, and joined JSON string.

## Checked and ruled out

“Ruled out” here means measured for the exercised arm, not assumed from code.

| Surface | Status | Evidence |
|---|---|---|
| WebSocket connection Map/listeners | **RULED OUT** | After 200 real connect/create/disconnect cycles: `ws_connections=0`, connected clients 0, output timers 0, active-handle delta 0, libuv delta 0. `cleanupWebSocketConnection` removes all listeners at `src/server.js:7011` and deletes the Map entry at `:7016`. |
| WS heartbeat timers | **RULED OUT** | One server-wide 15s interval at `src/server.js:3546-3552`, not per connection; libuv timer count did not grow. |
| node-pty wrapper/listener/job handles | **PROVEN leak on Windows; RULED OUT on Ubuntu** | After a 10s drain, Windows retained one `conhost.exe`, +22 server handles, +2 active handles, and +3 net libuv handles in every repeat despite bridge/listener/job counters reaching zero. Ubuntu returned to/below baseline. See Finding 1. |
| Output coalescing arrays/timers | **RULED OUT** | Every post-drain sample had pending chunks/bytes 0 and output-flush timers 0; flush cap is `src/server.js:6407`. |
| Fixed server timers/intervals | **RULED OUT as growth source** | Autosave, image sweep, eviction, diagnostics, disk sampling, restart monitor, and sticky poll are singleton timers. Active/libuv counts stayed flat and close clears them at `src/server.js:7097-7119`. Missing `unref()` affects process liveness, not count growth. |
| General EventEmitter long polls | **RULED OUT** | `ControlEventBus.waitFor` removes its listener and timer at `src/control/event-bus.js:229-245`; exercised non-PTY handle counts stayed flat. Only the small evicted-watermark Map remains as Finding 7. |
| Sticky JSONL file reads | **RULED OUT as whole-file retention** | `src/sticky-note-jsonl.js:35-36` caps one read to 512 KiB; `:155-220` parses a bounded range and returns compact turns/offset. `_claudeOffsets` is pruned against the 300-note cap at `src/server.js:6213-6216`. The separate unavailable-engine `pendingText` path is Finding 5. |
| File watchers / artifact SSE watchers | **RULED OUT for disconnect/end** | New artifact arm ended every review and watcher handles returned to baseline; the review objects remained. Existing deterministic cleanup tests cover `src/server.js:_cleanupFsWatchSession` and artifact `stopWatch`. |
| Sticky/STT worker respawn listeners | **RULED OUT by deterministic churn tests; model residency UNPROVEN** | Engine queues are capped at 3, crash paths clear queue/listeners, and `test/longevity/process/stt-worker-respawn.test.js` proves respawn cleanup. Existing soaks disable both models, so real llama/sherpa native RSS under day-long inference remains **UNPROVEN**, not ruled out. New worker-thread probes report each worker's own heap over `parentPort`. |
| UsageReader whole-file retention | **RULED OUT as permanent cache** | `src/usage-reader.js` streams JSONL via readline and retains one 5s aggregate cache. Per-request arrays can create large transient peaks against growing logs but are released. UsageAnalytics one-hour arrays are time-filtered; only stale `activeSessions` hygiene remains Finding 7. |
| Artifact SDK cursors/sandboxed files | **RULED OUT in supervisor heap** | SDK state is browser-side; files are disk state. Server-side review/chat/prompt/DOM retention is Finding 4. |
| Mesh manager stdout | **RULED OUT** | `src/mesh-manager.js:187-193` truncates its parser buffer at 256 KiB. |
| App tunnel stdout | **RULED OUT** | `src/tunnel-manager.js:317-329` parses chunks without accumulating a lifetime string. |
| Keepalive helper | **RULED OUT structurally; Windows live arm pending** | One persistent helper; no stdout string accumulator; release closes stdin and listeners. Windows handle/private-byte sampling is included in the opt-in workflow. |
| Supervisor wrapper | **RULED OUT in fresh arms** | Child stdio is inherited at `bin/supervisor.js:131-133`; crash timestamps are time-trimmed and capped at 1,024. Across all process-isolated arms the supervisor's control-subtracted heap delta was exactly zero while the server old-space grew. |
| HTTP auth rate limiter | **RULED OUT as live server cause** | `src/utils/auth.js` is not instantiated by `src/server.js`; its Map is time-cleaned if used. Control-route rate buckets are hard-capped at 2,000. |
| HTTP/SSE disconnect closures | **RULED OUT for exercised artifact/file-watch paths** | Listener and watcher cleanup returned handle counts to baseline. No response-body accumulator exists in the server streaming paths. |
| `activityBroadcastTimestamps`, `_stickyActive`, OSC7 state, steering queues | **RULED OUT** | Lifecycle deletes exist and post-drain counters returned to zero. OSC7 validation LRU is capped at 256. |
| `_controlIdempotency`, `_claudeNotes`, control event rings | **RULED OUT** | Caps are 500, 300, and bounded per-session/whole-session rings respectively. |

## Non-leak mechanisms

- **V8 retention vs fragmentation:** every finding's reported delta is after two
  full GCs. Session, artifact, and PTY arms grew old space by about 2.00, 3.34,
  and 2.70 MiB respectively. Heap-used rose with ownership counters; this is
  retained live data. Artifact heap-total rose about 20 MiB for 3.84 MiB net
  retained, so reservation/fragmentation adds RSS overhead but is not the root
  growth signal.
- **Native/external RSS:** session and artifact arms changed external and
  ArrayBuffer by only 8-10 KiB. PTY external/ArrayBuffer rose 0.59-0.62 MiB,
  materially below its 3.11 MiB JS-heap delta. Historical Windows external
  memory repeatedly collapsed while JS heap climbed to OOM. Native llama,
  sherpa, and long-lived ConPTY RSS still need the opt-in Windows/model arms.
- **File descriptors / Windows handles:** Linux active handles returned to
  baseline. Windows did not: the PTY arm proved +22 server handles, +2 active
  handles, +3 net libuv handles, and one surviving `conhost.exe` after 10s.
  `process.report.getReport().libuv` plus Windows `Get-Process HandleCount`,
  private bytes, and descendant PIDs closed the old `fd_count=null` blind spot
  and produced Finding 1.
- **Missing `--max-old-space-size`:** not a cause of growth. Production already
  starts the server with `--expose-gc`, and `restart-manager.js:22-23,29-32,49-59`
  runs GC/warnings at 1/2 GiB RSS. A heap-size flag changes when the process dies,
  not what stays live.

## Expected-red contracts

`test/longevity/diagnosis/memory-retainers.expected-fail.test.js` currently has
five deterministic failures:

1. 100 create/disconnect operations leave 100 live sessions (expected bound 50).
2. `ArtifactReviewStore.end()` leaves one review in `_reviews`.
3. 500 replies leave 500 chat entries while events correctly cap at 200.
4. Eight 64 KiB VS Code writes leave 524,331 retained stdout characters.
5. 100 x 1 KiB turns leave 102,499 pending bytes when the engine is unavailable.

`.github/workflows/memory-diagnosis.yml` runs these only by dispatch or the
`run-memory-diagnosis` PR label, requires the suite to be red, and remains
non-blocking. It then runs Node 22 process-isolated arms on Windows and Ubuntu.
Only derived JSON is uploaded; `.heapsnapshot` is never an artifact path.

## Instrumentation safety

- `/api/_diag/gc`, `/api/_diag/heapsnapshot`, and `/api/_diag/counters` are not
  registered unless `AOD_DIAG_ENABLED=1` **and** a 16+ character
  `AOD_DIAG_TOKEN` is present. A second constant-time token check is required per
  request. Tests prove 404 when either registration condition is absent and 401
  on mismatch.
- `/api/diagnostics` is unchanged and gains no GC/snapshot capability.
- `AOD_DIAG_*` secrets are removed from every user-controlled PTY/agent and
  long-lived tunnel/mesh/helper child environment.
- Snapshot writes are confined to `AOD_DIAG_SNAPSHOT_DIR`, preflight at 768 MiB
  used heap by default, and capped by count and aggregate bytes. Snapshot
  capture returns 503 unless that dedicated directory is explicitly configured.
- Diagnostic routes share the service listener rather than a loopback-only
  listener. They must never be enabled while the instance is reachable through
  a public, mesh, or VS Code tunnel, and diagnosis mode must be disabled after
  capture.
- Source-level ownership counters are inert until `AOD_DIAG_ENABLED=1`; the
  injected VS Code spawn seam resolves to the original `spawn` by default.
- The analyzer streams numeric/string arrays, excludes weak edges, computes
  immediate dominators and retained size, and redacts every string/path before
  writing derived output. Its synthetic fixture has a hand-derived
  `root -> Owner -> Child` graph plus a weak-only node.
- Existing `server-controller.js`, longevity gate thresholds, and existing
  workloads are untouched.

## Reproduction index

| Evidence | File |
|---|---|
| Empty session floor, save queue, WS/handle cleanup | `test/longevity/results/derived/sessions-linux-node22.json` |
| Real PTY output retention and PTY cleanup | `test/longevity/results/derived/pty-linux-node22.json` |
| Ended artifact review retention | `test/longevity/results/derived/artifacts-linux-node22.json` |
| Unavailable sticky-note retention | `test/longevity/results/derived/sticky-linux-node22.json` |
| VS Code stdout retention | `test/longevity/results/derived/vscode-linux-node22.json` |
| Redacted session dominators + ownership counters | `test/longevity/results/derived/session-dominators-linux-node22.json` |
| Current-PR Ubuntu matrix outputs | `test/longevity/results/derived/*-ubuntu-latest.json` |
| Current-PR Windows matrix outputs | `test/longevity/results/derived/*-windows-latest.json` |

The dominator aggregate is reproduced end-to-end with:

```text
npx -y node@22 test/longevity/harness/session-dominator-proof.js \
  --operations=100 \
  --out=test/longevity/results/derived/session-dominators-linux-node22.json
```

## Bottom line

The supervisor wrapper is not the growing heap. On Windows, each PTY lifecycle
also leaves a ConPTY host plus native server handles/private bytes after every
JavaScript lifecycle counter reaches zero; this is the highest-ranked
primary-platform cause. Independently, the server child retains production data
by policy: a count-unbounded seven-day session registry and per-session replay
tails bounded by callback count, not bytes, survive both client disconnect and
PTY exit. Artifact reviews, unavailable
sticky-note pending text, and VS Code stdout are additional linear retainers
when those features are active. Handles, WebSockets, PTY wrappers, singleton
timers, and native/external memory are not the primary mechanism in the
reproduced OOM.
