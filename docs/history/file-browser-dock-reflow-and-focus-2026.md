# File browser dock left the terminal narrow, and lost focus on WebKit

August 2026. Found by CI on the multi-viewer geometry branch, after the
docked-reflow behaviour landed.

## Symptoms

1. Opening the docked file browser above 1024px correctly narrowed the
   terminal (163 → 121 columns), but closing it never gave the columns back.
   The terminal stayed narrow for the rest of the session.
2. On WebKit, closing the panel with Escape left focus on `<body>` instead of
   returning it to the control that opened it. Keyboard and screen-reader
   users lost their place.

## Root causes

**Dock width was published as a side effect, not as part of the lifecycle.**
`_adjustTerminal()` is what writes `--fb-dock-width`, which
`.terminal-container` reserves as padding. It was called from four places, and
every one of them was a *view transition* — `_showBrowseView`,
`_showPreviewView`, and the two editor paths. Neither `open()` nor `close()`
called it.

Opening therefore worked by accident: opening navigates to the browse view, so
a view transition happened to follow. Closing is not a view transition, so
nothing cleared the property. The same gap applied to the viewport resize
handler, which updated overlay mode but never republished the width, so
dragging across the 1024px breakpoint left a docked width reserved under an
overlay layout.

**The opener was recorded as `document.activeElement`.** WebKit and Safari do
not focus a `<button>` on click, so by the time `open()` ran the active element
was `<body>`. The close path's guard treated that as "no usable opener" and
fell through to focusing the terminal. Chromium focuses buttons on click, which
is why only WebKit showed it.

## Fixes

`open()` and `close()` now publish and clear the dock width explicitly, and the
resize handler republishes it — coalesced to one animation frame, and skipped
when the measured width is unchanged, because each write drives a terminal
refit through the wrapper's ResizeObserver.

The opener is passed in by the caller, resolved by what is actually rendered
rather than by what dispatched the event: the mobile bottom nav opens the panel
by synthesising a click on the hidden desktop button, so the dispatching
element is not the one the user pressed. `document.activeElement` remains the
fallback for keyboard opens (Ctrl+B), where it is correct.

Because both openers sit behind responsive breakpoints, the opener is
revalidated at close time — a viewport change can leave it connected but
`display: none`, and focusing a hidden control strands focus on `<body>`. If it
is no longer visible the currently-rendered equivalent is used, and only then
the terminal. The focus call is checked against `activeElement` afterwards,
since `focus()` silently no-ops on a hidden or disabled target.

## What made this hard to see

Both defects were masked by tests asserting the wrong contract.

`74-client-shell-contract` asserted the file browser *never* resizes the
terminal. That is true in overlay mode and false when docked, so it passed on
the mobile project and failed only at desktop width. Making it modality-aware —
docked must reflow **and restore**, overlay must not touch the terminal — is
what surfaced the missing restore.

The WebKit focus defect was live on `main` and had no coverage at all. The
regression test for it drives the panel open at 1280px, narrows below 820px so
the opener is hidden, closes, and asserts focus landed on something with
rendered geometry. Verified to fail against the pre-fix code with
`focus landed on body-or-null`, so it discriminates rather than merely passing.

Note that the revalidation alone does not make that test fail: the
focus-took-effect check is what rescues the case. Both are kept — the check is
the safety net, the revalidation is what picks a *sensible* target rather than
falling back to the terminal every time.

## See also

- `docs/specs/file-browser.md` — dock/overlay contract
- `e2e/tests/74-client-shell-contract.spec.js`
- ADR-0052 (multi-viewer terminal geometry), which owns `--fb-dock-width` as
  the single source of dock width
