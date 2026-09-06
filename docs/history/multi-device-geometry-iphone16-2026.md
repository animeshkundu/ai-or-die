# Multi-device terminal geometry and iPhone 16 scaling — 2026

## Problem
When opening an existing session on a different device (such as an iPhone 16 joining an active desktop session), the session did not resize or scale to the device correctly:
1. The client never passed `claim: true` in its batched `_flushInput()` routine or secondary input handlers, so user keystrokes never satisfied the deliberate action gate on `server.js` (`data.claim === true`).
2. When the phone joined an existing desktop session, it was correctly designated a non-owner with `pan` regime, but there was no explicit user affordance to take control or fit to screen without typing.
3. On server restart or restoration of persistent sessions, `automaticLeaseAvailable` was set to false, leaving sessions in a state where sole active viewers could not easily establish ownership without typing.

## Solution
1. **Deliberate Input Claim Wire Contract**:
   - Centralized and updated all client input emission sites (`app.js` `_flushInput()`, clipboard paste, type-ahead input overlay, mobile extra-keys bar, mobile keys dialog, and terminal splits) to send `{ type: 'input', data, claim: true, viewId: 'main' }`.
   - Updated `server.js` and `terminal-geometry-coordinator.js` to process `claim: true` and atomically resize before bytes reach the PTY.
2. **Explicit Fit Screen / Take Control Action**:
   - Added a visible "Fit Screen" button (`#fitScreenBtn`) in the terminal toolbar that is shown when viewing as a non-owner in `pan` or `scale` presentation regime.
   - Clicking "Fit Screen" dispatches `geometry_take_control` along with local measured dimensions (`cols`, `rows`), immediately sizing the PTY to the viewing screen and switching presentation to `exact` regime.
3. **Automated End-to-End Validation (Option A)**:
   - Added an automated Playwright test (`test/e2e-geometry-iphone16.test.js`) validating the entire multi-device workflow using iPhone 16 device emulation against a live daemon on a high port with an isolated session directory.
   - Verified that desktop starts as owner (140x45), iPhone 16 joins as non-owner (panned with visible "Fit Screen" button), clicking "Fit Screen" transfers ownership and fits iPhone 16 exactly (44x30), desktop transitions to non-owner, and subsequent typing on desktop or phone cleanly re-claims ownership.
