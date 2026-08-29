# WebSocket Membership Transition Fencing

## What Happened

A single browser WebSocket could issue rapid `join_session` and `leave_session` messages while replay assembly was awaiting rendered terminal state. Asynchronous handlers could commit an older membership after a newer request, allowing old-session output to reach the wrong tab.

## Root Cause

Membership was stored directly on `wsInfo` while replay and geometry-detach operations yielded to the event loop. The socket could therefore be observed as belonging to one session while its session connection set still named another, and a closed socket could be re-added by a late continuation.

## Fix

The server now serializes create, join, and leave operations per socket, tracks a membership generation and committed transition ID, detaches old memberships before asynchronous work, and checks socket identity, generation, and open state before every commit. Same-session re-joins preserve the live session connection, committed membership tuple, and geometry attachment while replay is assembled, without emitting `session_left`. Tagged input is rejected when its session or transition does not match the committed active membership. URL auto-join uses the same queue without producing an explicit transition acknowledgment.

## Watch For

Keep the membership commit and `session_joined` response contiguous with no intervening await. Internal transition composition must not enqueue recursively. Any new await in a membership operation needs a map-identity, generation, and open-socket check afterward.

## Scope Note

The transition queue intentionally covers only membership operations. Input, output, heartbeat, and geometry controls retain their existing scheduling and terminal semantics. No files under `src/public/` are part of this server slice.

## Verification

Baseline: `b5b0249736502a77dcc0e7995c1e41a1516ea47f`.

The focused server membership, replay, output, and geometry suite reports 42 passing tests, including same-session no-detach, flow-resume, mid-replay membership, and tagged-input regressions. The membership transition file reports 17 passing tests. A broader relevant core run completed with 116 passing tests before these follow-ups. The integration run emitted one sandbox warning about an ENOENT session-store rename during a terminal activity test but completed without test failures.

Commands run:

- `node --check src/server.js`
- `node --check test/server-membership-transition.test.js`
- `git diff --check`
- `npx mocha --require test/hooks/session-sandbox.js --exit --timeout 5000 test/server-membership-transition.test.js test/join-replay-buffer.test.js test/output-throttle.test.js test/server-terminal-geometry.test.js`
- `npm run test:core -- --grep 'E2E: Server lifecycle|E2E: Session|server|join replay|Output Throttle'`

Windows CI and cross-platform browser verification remain the parent integration gate. Do not infer CI status from these local checks.

## Integration Invariants

- A closed socket must never be re-added by a late replay continuation, even if the target snapshot promise resolves after close.
- A tagged input frame is accepted only when both session and transition IDs are supplied, both match the corresponding committed membership values, and the socket remains in that session.
- The queue tail always resolves after an operation failure, allowing subsequent membership requests to execute in FIFO order.
- An untagged same-session re-join emits no `session_left`, preserves the live session membership and geometry attachment, clears any prior flow pause after successful replay, and preserves the committed transition tuple internally without echoing it.
- A response includes `transitionId` only when the corresponding request supplied a valid transition ID.
- Session-scoped exits and stopped frames carry `sessionId` additively. Error frames carry it when the server has session context; geometry hold timeout/truncation and generic start/parse errors may retain their legacy fields.
- The null bridge-session path releases the manual geometry output hold before returning.

No ADR was added. This is protocol hardening within the existing WebSocket/session architecture, covered by the server specification and protocol architecture docs.

No push was performed. The parent should integrate this Conventional Commit without client-file changes or unrelated copy/readiness edits, preserving the Windows timeout ancestry and copy/readiness work on the parent branch.
