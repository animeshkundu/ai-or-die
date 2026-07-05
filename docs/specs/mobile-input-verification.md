# Real-device verification checklist — iPhone 16 + iPad (gen 11), Edge on iOS

Edge on iOS renders with WebKit (ADR-0037), which the automated Playwright-WebKit
suite only approximates. This manual gate is REQUIRED before declaring the mobile
input work done. Run it on physical hardware, record a screen video, and judge
against the explicit pass criteria below. An adversarial observer (not the
implementer) signs off. Attach the video to the PR.

Environment: iPhone 16 (iOS latest) and iPad (gen 11), Microsoft Edge, app
installed to the Home Screen (PWA). Start Claude Code via `npx github-router@latest claude`.

## A. Install & launch (per device)
- [ ] Edge → Share → Add to Home Screen shows the correct name + crisp icon.
- [ ] Launches without Safari/Edge chrome (standalone) OR, if Edge-iOS opens it
      in-app, note the actual behavior (Edge-iOS A2HS standalone support is
      uncertain — record what happens).
- [ ] Cold launch shows the branded splash on the correct background (#161b22),
      no white flash. If splash does not appear under Edge, record it.

## B. No flicker (the core claim) — PASS = no visible double-flash or content jump
- [ ] Tap the terminal to raise the keyboard: the chrome collapses and the
      terminal reflows in ONE smooth motion. No flash, no stutter, no
      mid-animation clip of terminal rows.
- [ ] Dismiss the keyboard: single smooth restore, no jump.
- [ ] Repeat 10x rapidly: no accumulating jitter, no stuck layout.
- [ ] Open a modal (settings) with the keyboard up, then dismiss: no flicker.
- Objective bar: reviewing the recording frame-by-frame, there is at most one
  layout change per keyboard transition (the keyboard pushing content), never a
  flash-to-wrong-state-then-correct.

## C. Full keyboard reach (drive Claude by touch, no desktop) — PASS = task completed
Complete a real plan-mode Claude Code task using ONLY touch:
- [ ] Type a prompt in the composer (autocorrect does NOT mangle it), send it.
- [ ] Dictate a prompt by voice into the composer, edit, send.
- [ ] Cycle Claude's mode with Shift+Tab (bar or keys panel).
- [ ] Navigate an interactive menu with ↑/↓ and select with Enter.
- [ ] Cancel a running action with one-tap Ctrl+C.
- [ ] Press Esc to dismiss a prompt.
- [ ] Open the keys panel (⌨ FAB), send F-keys / Ctrl combos / Alt word-ops.
- [ ] Copy an error line from the terminal (Cp / Copy screen) and paste into the
      composer.
- [ ] Confirm arrows work INSIDE Claude's TUI menus (application-cursor mode) —
      not just at the shell prompt.

## D. Layout & safe area
- [ ] iPhone 16: nothing hidden under the Dynamic Island / home indicator.
- [ ] iPad (gen 11): touch chrome (bottom nav, hamburger) in both orientations;
      no clipped or overlapping chrome; no horizontal scroll.
- [ ] Artifact panel opens as a usable bottom sheet on iPhone; the sticky-note
      card docks as a full-width strip and is legible.
- [ ] Rotate both devices repeatedly: terminal reflows, no clipping.

## E. Offline
- [ ] Installed + Airplane Mode + relaunch: the app shell loads from the service
      worker (or the intended offline state), not a browser error.

## F. Images (desktop + mobile) — device-test findings, PR follow-up
- [ ] Desktop: paste a real photo (>1 MB) into the terminal → preview modal →
      Send. It uploads (over HTTP) and the `.claude-images/...` path is injected;
      NO "A voice message was rejected by the server. Reconnecting…" and no socket
      drop. (Root cause was image base64 exceeding the 1 MiB WS JSON guard.)
- [ ] Mobile: bottom nav → More → "Attach image" offers Photo Library / Take
      Photo / Files; the picked image previews and uploads; the path is injected.
- [ ] Mobile: copy an image, tap the extra-keys "Pst" key → the image preview
      appears (clipboard.read image path), send → uploads. Text paste still works.

## G. Mic in the composer (mobile)
- [ ] Open the composer (type-ahead input). Tap the mic: recording starts with a
      visible pulsing/red state ON THE COMPOSER's mic button (not the hidden
      header button). Speak → text lands in the composer. Tap mic again → stops.
- [ ] Close the composer while recording → recording stops (no stray dictation
      into the terminal).

## H. PWA top alignment (Edge on iOS) — RE-VERIFY, fix is device-unverified
- [ ] Installed PWA under Edge on iPhone 16: the top session-tabs bar clears the
      Dynamic Island (not tucked under it). The fix drives the top inset from
      `env(safe-area-inset-top)` unconditionally (no longer gated on a
      pwa-standalone class Edge doesn't set). If it is STILL cramped, env() is
      returning 0 in Edge's PWA and the JS polyfill needs a broader trigger —
      capture `getComputedStyle(document.querySelector('.session-tabs-bar')).paddingTop`
      and `getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-top')`
      on the device and report back.

Record: device, iOS version, Edge version, and a screenshot/clip per section.
