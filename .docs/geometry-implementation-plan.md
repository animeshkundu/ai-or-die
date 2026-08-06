# Terminal geometry: finalized implementation plan (recovered)

Recovered from the preserved node outputs of factory run `30982402342`, which implemented this
work and then aborted (`[SdkBackend] Session aborted`) before finishing. Code output was recovered
separately from the run's checkpoint; this document is the **thinking**, so the remaining work does
not have to be re-derived.

Source: `state/.opus5-holistic-flow-data/.../output/{spec,research,plan,plan-review}.log`.
Content below is quoted or closely paraphrased from those logs. Where the logs are ambiguous or a
question was never resolved, that is stated explicitly rather than filled in.

## Design (as finalized, post-review)

Explicit ownership, **not** most-recent-writer:

- Attachments **advertise** capacity; advertising must NOT claim the PTY.
- Exactly one attachment holds an owner **lease**; only the owner's capacity drives `pty.resize`.
- The lease transfers only on a **deliberate** act, never on an incidental layout event.
- Server assigns a **monotonic revision**; a **session epoch** covers restart.
- State is keyed by `(sessionId, connectionId, viewId)` — not `wsId`, because one socket hosts
  multiple split panes.

Three layers: (1) measurement/advertisement, (2) ownership lease and PTY sizing, (3) non-owner
rendering.

## Acceptance criteria (recovered verbatim in substance)

| ID | Criterion |
|----|-----------|
| AC-1 | Sole-viewer desktop resize still tracks the PTY exactly (110x35). |
| AC-2 | **Not satisfied by grid equality alone** — requires BOTH grid-vs-PTY equality AND a live-DOM presentation assertion: the regime dataset attribute, effective cell width above the minimum threshold after scaling, and the cursor cell within capacity bounds with a margin band. |
| AC-3 | All three disconnect directions (non-owner leaves, owner leaves, last leaves). |
| AC-4 | Docked chrome occludes ZERO columns — the terminal rect never intersects the panel rect at any point, across open/close/drag. |
| AC-5 | No resize storm: `<=1 pty.resize` over 5000 ms idle with two viewers, **plus a mandatory active counter-test**. |
| AC-6 | Resize transactions atomic and ordered: resize-caused output never renders at the old dimensions. |
| AC-7 | The four previously-unmeasured cases (phone orientation, iOS soft keyboard under WebKit, split panes, reconnect-after-drop) measured with reported numbers, and none produces an ownership claim. |
| AC-8 | Every previously reachable feature remains reachable. |
| AC-9 | Accessibility proven by **measurement, not inspection**: executable WCAG 2.2 AA contrast check, >=44 px hit targets, full keyboard operability with visible focus and correct roles/labels/tab order, `prefers-reduced-motion` and `prefers-color-scheme` honoured. |
| AC-10 | Both screenshot deliverables: the 32-baseline deterministic gate AND the exhaustive review artifact with before/after pairs. |
| AC-11 | Input latency and output throughput measured on the base commit before any styling lands and again after; both real numbers reported; after-values within pre-existing budgets. |
| AC-12 | Every surface visually and interactively coherent: one visual direction, one icon grammar, consistent density, alignment, elevation, motion. |

Stated baseline to hold: `npm test` green at **2020 passing, 4 pending, 0 failing**.

## Risks the plan review caught

These are the highest-value part of the recovery. Several were not identified in the original
brief and would have been easy to reintroduce.

1. **Oscillation in a new disguise (highest severity).** Any implementation that makes the render
   regime perturb its own measurement inputs reproduces the previously-refuted oscillation.
   **Font-size scaling does exactly that**, because the vendored fit addon divides by the live
   font-derived cell metric. Mitigation is structural: CSS transform on an inner stage, a single
   cell metric, `k` continuous and clamped at 1 — plus an explicit **hold-steady regression test**.
   Without that test the failure is invisible to both promoted probes and surfaces only as flaky
   AC-2/AC-3 assertions.

2. **Sticky-note regression created by this change.** The sticky-note summariser is resized from the
   RAW advertisement, before and outside the agent gate (`server.js:3853-3855`). Decoupling
   advertisement from the PTY silently turns a phone's 38-column advertisement into the wrapping
   width for the transcript feeding the summariser and the auto tab title, **for every viewer, with
   zero signal in either probe**. This is a regression the change itself creates and must be fixed
   in the same work.

3. **Resize failure is swallowed twice** — `base-bridge.js:609-613` (warn) and `server.js:3863-3867`
   (dev-only log). If either survives, "applied updates only after `pty.resize` succeeds" is
   unimplementable and AC-6 cannot be honestly demonstrated.

4. **The idle resize-storm bound passes vacuously** if the protocol is broken such that nothing ever
   resizes. Mitigated only by the mandatory active counter-test.

5. **AC-2 becomes tautological** if asserted against `terminal.cols`, since Layer 3 sets exactly that
   value from the authoritative frame. Must be asserted against live DOM presentation.

6. **Reparenting the file-browser panel across the 1024 px breakpoint** would tear down Monaco, drop
   focus, and break the existing focus assertion at `74-client-shell-contract.spec.js:55`. Mitigation:
   give the panel one permanent home in the dock track (a one-line change to the append at
   `file-browser.js:624`) and express overlay mode purely in CSS, so no node ever moves.

7. **`position: fixed` inside the dock track** silently becomes track-relative if any ancestor gains
   `transform`, `filter`, `perspective` or `contain: paint`. Verified clean today; needs an explicit
   invariant test rather than an assumption, because the redesign is very likely to add transforms
   to shell chrome.

8. **Part B is far larger than commonly estimated** — the log quantifies 165 ids, 178 dynamic class
   names, and 441 CSS (rules/declarations; the log is truncated at this point).

## Additional review requirements

- The scale regime must be a **pure function of (outer rect, applied, cell metric)** and provably
  must not perturb its own inputs — demonstrated by a test holding a non-owner at capacity < applied
  for several seconds with `data-regime` constant and advertisements bounded.
- **No DOM node reparented across the 1024 px breakpoint** — demonstrated by a breakpoint-crossing
  test with the panel open asserting focus, Monaco layout and scroll position all survive.
- **`--fb-dock-width` is the single owner of dock width** — demonstrated by a test where drag and
  editor-active compose rather than fight.
- AC-1 has a known seam at 110x35: the fix is to move the padding and ruler subtraction to the outer
  element calculation **before** applying reserve, rather than relying on the addon's internal
  arithmetic.

## What remains undone

The run aborted partway. Confirmed outstanding:

1. **The superseding ADR was never written.** The plan named `docs/adrs/0050-multi-viewer-terminal-geometry.md`
   and `docs/adrs/0051-design-system-and-interaction-model.md`. **Note a collision:** `0050` has since
   been taken by `0050-session-scoped-shell-integration.md` (merged via #159), so these need renumbering
   to `0052`/`0053` or later.
2. **Layer 3 non-owner rendering appears incomplete.** Measured after recovery: with a desktop owner at
   163x45 and a phone attached, the phone's xterm sits at its own 38x39 rather than presenting the
   applied 163x45 via the scale/letterbox regime. Whether Layer 3 was descoped or simply not reached
   is **not resolved by the logs**.
3. **The sticky-note advertisement regression (risk 2) — status unknown.** Not confirmed fixed in the
   recovered code; must be checked before merge.
4. **AC-7's four measurements** (orientation, WebKit soft keyboard, split panes, reconnect-after-drop)
   — no evidence in the recovered output that these were run.
5. **AC-11 before/after latency and throughput numbers** — no evidence they were captured.
6. **Part B (UI/UX redesign)** — partially present (`tokens.css`, `icons.js`, `controls.css`,
   `file-browser.css` modified; a contrast test added), far short of the full scope in AC-12.

## Verified working after recovery

Not from the logs — measured directly against the recovered code:

- 31 new unit tests pass (`terminal-geometry-coordinator`, `server-terminal-geometry`,
  `design-token-contrast`).
- `scripts/probe-multi-viewer-resize.js` against the recovered branch: the three original defects are
  fixed. Desktop stays consistent with the PTY when a phone joins (163x45 = 163x45), self-heals, and
  reclaims after disconnect. Probe scenario 2 now reports FAIL only because the probe encodes the old
  last-writer semantics; the phone correctly advertises without claiming.
