# ADR-0049: WebKit engine scope for CI gates

## Status

Accepted (2026-08-04). Amends ADR-0037 on one point: the `test-browser-ios-webkit` job runs on `ubuntu-latest` only. Every other part of ADR-0037 stands.

## Context

Two questions kept being answered ad hoc, in a workflow comment and in a project comment that disagreed with the ADR they cited. This records the answers once.

**1. Playwright-WebKit on the Windows runner.** ADR-0037 required `test-browser-ios-webkit` on ubuntu **and** windows. That requirement did not survive contact with the runner. `.github/workflows/ci.yml` has carried a comment since the xterm 6.0 upgrade documenting that Playwright-WebKit on the Windows runner wedges WebSocket *inbound* frame delivery ~15-30s after connect once the page is heavy enough: the terminal joins, the heartbeat pong stops arriving, the socket is force-closed, and the close handshake hangs ~30s. Bigger timeouts (60/120/180s), disabling the service worker, and vendoring the assets were all tried and ruled out. The job matrix was narrowed to `ubuntu-latest` accordingly, but ADR-0037 was never amended, so the repository stated two different things.

Re-adding `windows-latest` reproduced it exactly: all 6 tests **passed**, then the job failed anyway with `worker-N process did not exit within 300000ms after stop, force-killed it` for three workers. The failure is in engine teardown, not in any assertion.

**2. Absolute frame-time budgets under headless WebKit.** `e2e/tests/75-client-performance-report.spec.js` asserts absolute frame-time ceilings. On one CI run, the same client code on the same runner measured:

| Metric | Chromium | headless WebKit |
| --- | --- | --- |
| Time to interactive, desktop | 2,775 ms | 10,324 ms |
| Flood drain, desktop | 551 ms | 1,920 ms |
| Flood drain, iphone-portrait | 318 ms | 1,085 ms |
| Scroll p95 frame gap, desktop | 33.3 ms | 388 ms |
| Scroll p95 frame gap, iphone-portrait | 16.7 ms | 123 ms |

The wire numbers were near-identical (336,306 bytes / 12 frames desktop on both), so the pipeline behaved the same; only rasterization differed. Headless WebKit on Linux composites in software with no GPU. Real iOS 16 Safari does not. A ceiling that a GPU-less container cannot meet grades the container.

## Decision

**Windows WebKit.** `test-browser-ios-webkit` runs on `ubuntu-latest` only. WebKit remains a hard gate there: an engine that cannot initialize `window.app`, the terminal, or the required mobile controls fails the job rather than being converted to a skipped test or substituted with Chromium. Windows users run Edge (Chromium), which the `test-browser-*` matrix already covers on `windows-latest`. This is recorded here, in an ADR, instead of only in a workflow comment, so the repository stops contradicting itself.

**Engine-scoped performance budgets.** `75-client-performance-report.spec.js` runs on every redesign project, WebKit included, and splits its assertions in two:

- *Engine-independent invariants*, asserted everywhere: the client drained the flood with nothing left queued (`pendingWriteBytes === 0`), plan detection stayed bounded, the frame probe collected samples, server-side coalescing held (the flood arrived in a bounded number of binary frames rather than hundreds), and the scrollback filled. These measure the output path, which is the thing the client owns.
- *Absolute frame-time ceilings*, asserted on Chromium only: `flood.maxGapMs`, `flood.maxLongTaskMs`, and `scroll.p95GapMs`. Chromium runs on both `ubuntu-latest` and `windows-latest` via the `client-redesign` and `client-redesign-mobile` projects, so the ceilings still gate the primary server target.

Measured numbers are printed and attached as `client-performance.json` on every engine, so a WebKit regression is still visible in the job log and artifact even where it is not a hard gate.

Budgets are also scoped to the phase they are named for. The flood budget samples the flood window only; previously a single whole-test maximum was asserted, which spanned the deliberate scroll-jank loop and every harness round-trip and therefore reported the scroll phase rather than the output pipeline.

## Consequences

- The `os` matrix for `test-browser-ios-webkit` is `[ubuntu-latest]`, and the comment in `e2e/playwright.config.js` that claimed ubuntu + windows "as required by ADR-0037" now points here.
- Restoring Windows WebKit requires fixing the engine teardown wedge first, and amending this ADR.
- The `client-redesign-webkit` project excludes exactly one case, the split-geometry contract, via `grepInvert`. Split view is desktop-only -- the client refuses it below 700px of available width and tells the user to use session tabs -- and under WebKit's phone device profile `setViewportSize` does not reliably yield a desktop-class layout, because `width=device-width` governs the layout viewport. The case keeps running on `client-redesign` and `client-redesign-mobile` across ubuntu and windows. Every other case in specs 74-76 runs on WebKit.
- A WebKit-only rasterization regression will not fail CI. It will appear in `client-performance.json`. Accepted deliberately: the alternative is either a ceiling calibrated from a single sample, which flakes, or deleting WebKit coverage entirely, which is worse.
- Real iOS 16 hardware timings remain unverified by CI on any engine. `docs/specs/mobile-input-verification.md` stays the required manual gate.

## Statistic choice for the flood budget

The flood frame budget gates on the **median** frame gap, not the maximum. Within one hour, on an unchanged and demonstrably healthy pipeline -- write queue drained, ~336KB delivered in 10-12 coalesced binary frames -- the flood-window maximum measured 16.8ms locally, 50ms on the Windows runner and 66.6ms on the Linux runner. A maximum over roughly twenty samples on a shared two-core runner measures contention, and gating on it produces a flaky check, which this repository treats as a defect in its own right.

The median is robust to that and still fails hard on a real regression: a pipeline that stopped bounding work per animation frame moves the whole distribution, not only its tail. Single-task main-thread blocking remains separately gated by `flood.maxLongTaskMs <= 100`, and the drained-queue and coalescing invariants gate the output path directly. Maximum and p95 are still recorded in `client-performance.json` for human review.
