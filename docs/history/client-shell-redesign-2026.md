# Client shell redesign — 2026

The client shell previously allowed auxiliary drawers to change terminal geometry, and repeated fits could oscillate because xterm was first fitted and then resized again with a fixed reserve. Hidden split panes could consequently emit tiny resize messages to a live PTY.

The repair established one resize owner, refused zero-axis measurements, resumed deferred fits through `ResizeObserver`, and made non-terminal surfaces overlay-only. Browser output bookkeeping moved behind the existing animation-frame write boundary with a bounded per-frame byte budget. Mobile layout now uses `visualViewport`, four-axis safe-area tokens, dynamic viewport units, 44-pixel coarse-pointer targets, and explicit focus behavior.

Reconnect replay now treats the server buffer as the authoritative boundary. Bytes still queued from the closed socket are discarded before replay so they cannot be duplicated, and the terminal restores the pre-disconnect viewport and selection after the replay drains.

## Performance measurements

The pre-change research baseline used a 375,277-byte Chromium desktop burst that arrived in 12 frames and drained in 248 ms; its maximum long task was 229 ms and maximum animation-frame gap was 232 ms. The same research run found the WebKit phone delivery shape could fragment into 228 mostly sub-1-KiB frames with 298 ms median sampled frame time.

The repeatable post-change probe in `e2e/tests/75-client-performance-report.spec.js` measures both 1280x800 and 393x852. The final local desktop-Chromium project run produced:

| Viewport | Cold ready | Flood payload | Wire frames | Flood observed | Max long task | Max frame gap | Residual queue |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1280x800 | 1,960 ms | 336,413 B | 10 | 254 ms | 0 ms | 16.8 ms | 0 B |
| 393x852 | 1,100 ms | 368,429 B | 12 | 266 ms | 0 ms | 16.8 ms | 0 B |

The final run detects the local SwiftShader renderer and selects xterm's DOM renderer instead. That removes the software-WebGL GPU stalls measured in the prior run (546 ms maximum long task, 567 ms maximum frame gap, and 367 ms p95 deep-scroll gap). With the 96 KiB frame budget, both final viewports recorded zero long tasks and 16.8 ms maximum frame gaps. Keystroke-to-echo was 33.8 ms / 22.1 ms, and sixty consecutive deep-scrollback steps held both maximum and p95 frame gaps at 16.8 ms with 1,039-1,040 buffered lines. Client staging drained fully. Hardware-backed desktop WebGL remains the preferred runtime path; the software-renderer fallback is now explicitly selected instead of accepted as degraded performance. A separate ANSI-rich sustained-output run measured keystroke round-trip latency at p50 228 ms, p95 562 ms, with all 15 probes completing.

Local Playwright WebKit wedged before completing the shell suite in this environment, so post-change WebKit timing, real iOS 16 hardware timing, true process suspension, deep-scrollback frame timing, and a repeated five-cycle heap slope remain unverified. The pre-change heap baseline remains 14,882 / 14,954 / 14,996 / 15,042 / 15,111 KiB with the DOM flat at 1,211 elements; it is not presented as an after measurement.
