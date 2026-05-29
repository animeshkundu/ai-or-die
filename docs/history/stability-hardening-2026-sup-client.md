# SUP-CLIENT Lane Post-Mortem — stability-hardening-2026

**Date:** 2026-05-28
**Campaign:** stability-hardening-2026
**Lane:** SUP-CLIENT (browser-tab longevity)
**Files modified:** `src/public/plan-detector.js`, `src/public/app.js`
**Files added:** `docs/audits/client-plan-detector.md`, `docs/audits/client-listener-accumulation.md`, `docs/audits/client-diagnostics-scrollback.md`, `docs/specs/client-longevity.md`, `test/longevity/playwright.config.js`, `test/longevity/browser/plan-detector-byte-cap.test.js`, `test/longevity/browser/reconnect-storm.test.js`, `test/longevity/browser/diagnostics-shape.test.js`
**Tests touched:** `test/plan-detector.test.js`
**Specs touched:** `docs/specs/client-longevity.md` (new)
**Branches:** `sup-client/client-01-byte-cap` (`5760c5d`), `sup-client/client-02-listener-audit` (`7bd7d5b`), `sup-client/client-03-diagnostics` (`d7f5763`)

## Charter

Three task clusters, scoped from a memory + listener + DOM audit of the long-lived browser tab:

| ID | Cluster | What we suspected | What we shipped |
|---|---|---|---|
| CLIENT-01 | `PlanDetector.outputBuffer` byte cap | 10000-item cap admitted ~80 MB tab heap under heavy PTY output | 8 MB byte cap with FIFO eviction; same item is unbounded only on chunk count, never on bytes |
| CLIENT-02 | Listener accumulation across reconnects | `addEventListener` inside `onopen` handler that re-fires per reconnect, no `removeEventListener` | **Zero actual leaks** — codebase uses property-assignment uniformly; forward-looking regression guard only |
| CLIENT-03 | `window.__diagnostics()` + xterm scrollback | Unknown scrollback bound; no client-side observability for the soak harness | xterm bounded at `scrollback: 10000` (sane); added `window.__diagnostics()` mirroring server shape |

## What each cluster found and fixed

### CLIENT-01 — plan-detector buffer (the only actual fix in the lane)

**The bug.** `src/public/plan-detector.js` kept a rolling buffer of PTY chunks for re-scan when a trigger keyword arrived. The cap was item-count: 10 000 entries pruned to 5 000 on overflow. Per-entry data was the raw chunk string handed to `processOutput()` — typical PTY output runs the coalescer up to 32 KB; in normal operation 1–8 KB chunks are common. Worst case: 10 000 × 8 KB ≈ **80 MB of retained string memory per tab**. V8 stores most of this as two-byte strings, so actual heap is double. The only path to clear was a full tab refresh, `setTool()`, or `stop/startMonitoring()` — none of which fire on long passive sessions.

**The fix.** Replace item-count cap with byte-count cap:
- `maxBufferBytes = 8 * 1024 * 1024` (8 MB hard cap)
- `bufferBytes` running total of `data.length` across the live buffer
- Push path: `bufferBytes += data.length`
- Eviction: `while (bufferBytes > maxBufferBytes && outputBuffer.length > 0) { shift; subtract }`
- Reset: `startMonitoring` / `stopMonitoring` / `clearBuffer` zero `bufferBytes`

**Why `data.length` and not `Buffer.byteLength`.** Hot path. `data.length` (UTF-16 code-unit count) equals bytes for ASCII (vast majority of PTY) and 2× under-estimates for two-byte strings. V8 stores those as 2 bytes per unit internally, so `data.length` is a faithful proxy for V8 string heap cost. Pathological case: 8 MB in `data.length` ↔ 16 MB actual heap — still 5× lower than the pre-fix worst case.

**Why 8 MB.** Two constraints: must hold worst-case plan extraction (`getRecentText` clamps at 50 000 chars × 2 = 100 KB, 80× headroom at 8 MB) and must not be a noticeable tab footprint (8 MB is < 1 % of typical Chromium tab budget).

### CLIENT-02 — listener-accumulation audit (zero leaks found)

**Hypothesis going in.** The classic browser leak pattern is `socket.addEventListener('message', handler)` inside an `onopen` handler that fires on every reconnect, with no matching `removeEventListener`. Audited `app.js`, `session-manager.js`, `file-watcher-client.js`, `heartbeat-watchdog.js`, `file-browser.js`.

**What we found.** Zero. A `grep -r addEventListener src/public/*.js` against every WebSocket / EventSource / socket-like object returned no matches. The codebase consistently uses property-assignment (`ws.onmessage = …`, `es.onmessage = …`) for every transport handler. Reconnect paths in `app.js:1813` and `file-watcher-client.js:269` null the prior transport in their teardown (`disconnect()` / `_tearDownEventSource()`) before constructing a fresh one. Generation fences (`_socketGeneration` / `isCurrent()`) further prevent stale callbacks from acting after a reconnect — which itself came from the May 2026 instant-reconnect work (see `docs/history/instant-websocket-reconnect.md`).

**What we shipped anyway.** A forward-looking regression test: `test/longevity/browser/reconnect-storm.test.js` installs an `addEventListener` counter on `WebSocket.prototype` before app load, cycles 25 WS reconnects via server-side `client.terminate()` (not `close()` — clean close marks `event.wasClean=true` and skips reconnect, masking the test), and asserts zero `addEventListener` accumulation. The test PASSES on main today; it exists to FAIL the moment somebody migrates a transport handler to `addEventListener` without matching `removeEventListener`.

**The empirical upgrade from the soak.** The 60-min bundled soak surfaced `client.dom.total_nodes` slope of 31.7 nodes/hour against a 100/hour threshold. That is the leakproof claim moved from "theoretical (audit-by-grep)" to "empirical (60 min sustained load with the reconnect-storm fixture running)" — a stronger guarantee than the audit alone provides.

### CLIENT-03 — `window.__diagnostics()` and xterm scrollback

**Two halves.**

*Half A — xterm scrollback audit.* `src/public/app.js:572` sets `scrollback: 10000` (10× xterm default of 1000). Bounded, sane, not a leak. Secondary terminal in `src/public/splits.js:42` omits the option and inherits xterm's 1000-line default — bounded but inconsistent. Documented in spec as future cleanup; not in scope here.

*Half B — `window.__diagnostics()`.* New browser-side global that mirrors the server `/api/diagnostics` shape. SUP-SOAK consumes it via Playwright `page.evaluate(() => window.__diagnostics())` at 60 s cadence in the browser portion of the soak. Returns a Promise (the optional `performance.measureUserAgentSpecificMemory()` call is async). All sub-collectors wrapped in try/catch so the function NEVER throws. Installed at module level so it is callable from script load forward — even before `window.app` is constructed or any session is joined. Spec at `docs/specs/client-longevity.md` is the canonical contract.

**Defensive coding that paid off.** The diagnostics implementation prefers `pd.bufferBytes` (added by CLIENT-01) but falls back to summing `entry.data.length` over `pd.outputBuffer` if the field is missing. SUP-SOAK's SOAK-05b smoke test ran against pre-CLIENT-03 main; the harness gracefully degraded to a `meta` row recording `window_diagnostics_present = 0` then short-circuited the gate. That smoke surfaced the integration without blocking on CLIENT-03 having landed first.

## What the harness validated, and what it didn't

The 60-min bundled soak captured five `client.*` gates against the spec thresholds:

| gate | threshold | observed | verdict |
|---|---|---|---|
| `client.plan_detector.bytes` | ≤ 8 MB | peak 0.00 MB (vacuous — pty-flood bypasses the WS broadcast path) | PASS but vacuous |
| `client.dom.total_nodes` slope | < 100/hour | 31.7/hour over 62 samples | PASS (empirical) |
| `client.xterm.scrollback_lines` | ≤ 10 100 | peak 35 | PASS |
| `client.ws.state` | == 1 post-baseline | stable at 1 across 60 min | PASS |
| `client.sse.streams` | slope ≤ 0 | 0 throughout | PASS |

The `client.plan_detector.bytes` gate is the only one that did not give a strong signal. SUP-SOAK's pty-flood workload drives `terminalBridge._handleOsc7Chunk` internally and does NOT broadcast over WS to attached browser tabs, so the sampler page's plan-detector buffer never received any PTY chunks. CLIENT-01's cap enforcement is independently verified by deterministic unit tests (100 MB synthetic flood with accounting-invariant check, plus Playwright spec exercising the same path in the actual browser environment) — the soak's vacuous PASS is a harness gap, not a CLIENT-01 regression. SUP-SOAK filed SOAK-05n to add (a) a WS-broadcast variant of pty-flood and (b) a "meaningfulness-check" generalization where any cap-style gate fails on zero observed activity unless explicitly marked ceiling-only.

The real failure CLIENT-01 prevents — tab heap monotonically climbing to OOM over days under sustained heavy output — is not observable in a 60-min soak anyway. The original bug took days-to-weeks to bite. A 4 h or 12 h soak via the real WS path would be a more honest detection horizon and is the gating window for any future re-verification.

## Lessons (codebase-specific)

1. **Item-count caps lie about memory bounds when per-item size is unbounded.** Always measure the axis that actually constrains the resource (bytes, file descriptors, RSS) and not a proxy that drifts. The `PlanDetector` cap looked fine on paper at 10 000 entries; on a noisy PTY it admitted 80 MB. Same lesson applies to any future bounded buffer the codebase introduces.
2. **Audit-by-grep is necessary but not sufficient evidence of absence.** CLIENT-02 found no `addEventListener` on transports today, but that doesn't tell us the pattern won't appear tomorrow. The forward-looking regression test (25-cycle reconnect storm asserting zero `addEventListener` accumulation) is what makes the audit's claim durable. A future PR that introduces the anti-pattern fails the test; without the test, the audit is a snapshot.
3. **Diagnostics surfaces want defensive fallbacks.** `window.__diagnostics()` prefers `pd.bufferBytes` but falls back to `sum(entry.data.length)` if the field is missing. That single fallback path let CLIENT-03 ship a useful smoke-test run against a pre-CLIENT-01 main. Without it, the SOAK-05b smoke would have crashed on `pd.bufferBytes === undefined` and we'd have re-ordered the merge sequence.
4. **Cap-style gates can pass vacuously.** The `client.plan_detector.bytes` PASS at peak 0 MB was honest reporting of the harness gap, not a CLIENT-01 regression — but a less attentive reader could have read "PASS" as "the cap held". Generalized as "any cap-on-observed-activity gate should fail-on-zero-activity unless marked ceiling-only" (SOAK-05n). This is a harness invariant, not a SUP-CLIENT change, but the discovery came from SUP-CLIENT's gate.

## Lessons (campaign-specific)

5. **Shared working trees collide when multiple supervisors switch HEAD.** Pre-worktree-discipline, two SUP-HOT commits landed on `sup-client/client-01-byte-cap` because the root checkout's HEAD was on the SUP-CLIENT branch when the SUP-HOT session committed. Each recovery cost a few minutes but no data was lost (SUP-HOT extracted patches and reset cleanly). The campaign-wide fix was SUP-REL's HEAD-discipline rule: every non-REL supervisor commits only from their own `git worktree`. Implemented mid-campaign; worth codifying for the next multi-supervisor campaign.
6. **Bundled PRs beat per-supervisor PRs for fast-moving campaigns.** The original plan was one PR per gap. The team-lead pivoted to a single bundled PR after the first few branches showed how fast supervisors could move. That kept CI cost bounded, kept the review surface coherent, and let SUP-REL handle merge sequencing in one pass. The trade-off is loss of per-gap revert granularity — acceptable for a campaign that's all-or-nothing on the longevity claim, less so for routine feature work.

## What's still open

- **SOAK-05n** (filed): WS-broadcast variant of pty-flood + vacuous-PASS guard for cap-style gates. Not blocking CLIENT-01 ship.
- **`splits.js` scrollback parity** (flagged in spec, out of scope): align secondary-terminal `scrollback: 10000` with the main terminal. UX cleanup, not a leak.
- **COOP/COEP for actual `measureUserAgentSpecificMemory()` bytes**: the dev/test server doesn't set the headers, so `__diagnostics().memory` falls back to `{deviceMemoryGB: navigator.deviceMemory}` (coarse hint, not real usage). If SUP-REL ever adds the headers to a test-only server, the harness picks up real bytes automatically.
- **CLIENT-04** (not filed): if SUP-SOAK finds the `bufferBytes` surface awkward in practice during the post-bundle 4 h soak, add a getter and a `_resetForSoakBaseline()` helper. Not requested as of bundle-ship.

## Verification

- `npm test -- test/plan-detector.test.js` → 17/17 mocha, ~150 ms
- `npx playwright test --config test/longevity/playwright.config.js` → 5 specs (1 plan-detector + 1 reconnect-storm + 3 diagnostics-shape), ~22 s total
- 60-min bundled soak with `--browser-page` → 4/5 client gates PASS, 1 vacuous (see harness-gap note above)
- `meta.window_diagnostics_present == 1` across all 62 browser samples → confirms CLIENT-03 actually shipped in the merged tree
