# Terminal geometry and command deck — 2026

The client previously treated each browser attachment as the only viewer of a
shared PTY. A phone layout event could resize the PTY while desktop xterm kept a
wider grid, and disconnect did not restore the survivor. The desktop file
workspace was fixed over the terminal, hiding live columns.

The repair introduced a server-owned attachment lease, session-scoped
epoch/revision frames, serialized resize and claim-carrying input, deterministic
successor transfer, and authoritative non-owner rendering. The file workspace
now owns a real desktop layout track and remains the same fixed overlay node on
narrow layouts. The inner terminal stage pans when it cannot fit; it never
scales, so pointer-to-cell mapping remains exact.

The same change rationalized the UI as the Quiet Command Deck. System, Light,
and Dark replace partially independent named palettes; legacy values migrate
without a blank state. All sixteen terminal colors, native color scheme, Monaco,
focus treatment, hit targets, elevation, motion, and SVG geometry now derive
from shared foundations.

Regression coverage promotes the original probes into Playwright and adds
unit boundaries for ownership, validation, stale revision rejection, failure
propagation, output ordering, withdrawal, persistence, theme migration, and
contrast.

Follow-up review closed four ordering and interaction gaps: owner layout
advertisements now collapse to one trailing resize, queued browser output drains
before authoritative xterm mutation, join replay excludes redraw bytes still
held behind a geometry frame, and the file-workspace separator supports pointer
and keyboard resizing. The derived browser matrix now includes the new WebKit
projects on their supported Linux host.

The full browser run also exposed that split creation resolved at socket
construction rather than session readiness. Split connections now resolve only
after join replay completes, preventing late replay from erasing immediate user
interaction.

Split activation now waits until both pane joins are ready and rolls back cleanly
when either connection fails. Fire-and-forget tab switching reports a visible
error instead of leaving an unhandled promise. The baseline workflow now owns
the desktop and WebKit design-system matrices as well as the legacy visuals.

Final review closed the remaining interaction gaps: same-owner typing commits
any pending authoritative layout resize before its bytes reach the PTY, startup
output has an unconditional release,
the file-workspace separator no longer covers terminal input, coarse-pointer pan
cannot be trapped by xterm scrollback, and both main and split views expose a
take-control action for vacant or remote leases. The active coalescing and
reconnect probes now change timing and capacity so they fail if the behavior is
removed.

Release validation also separated the core suite and gives each control test
file a fresh Node process in sorted order. In the previous single 14-minute
process, the complete 2,056-test run left six otherwise-passing control requests
beyond the unchanged five-second limit. Diagnostics showed 4,885 pending native
requests and 1 GB RSS after the artifact/JSONL files; Mocha's single parallel
worker also reused one process and retained the requests. File-scoped processes
keep the original assertions, serial ordering, and timeouts intact instead of
masking the leak with a larger budget.

Final same-run performance comparison against commit `405ca8d` kept terminal
latency and throughput effectively flat. Under the ANSI-rich output flood,
keystroke p50/p95 moved from 60/78 ms to 62/76 ms. The desktop flood moved from
279 ms to 271 ms with 10 wire frames; phone-profile Chromium moved from 261 ms
to 278 ms with 12 frames. Both runs drained all client staging, recorded zero
long tasks, and held median frame gaps at 16.7 ms.
