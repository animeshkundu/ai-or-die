# ADR-0006: Fix the Code, Not the Test

## Status

**Accepted**

## Date

2026-02-06

## Context

During Playwright E2E test development, the test suite discovered real bugs in `src/public/app.js`:

1. **WebSocket never connects on fresh machines.** The `init()` method only called `connect()` when joining an existing session. On fresh machines with no sessions, the socket stayed null, silently dropping all `this.send()` calls.

2. **Tool cards hidden by premature overlay hide.** After joining a session where no tool is running, the `session_joined` handler correctly shows the start prompt with tool cards. But `init()` unconditionally called `hideOverlay()` afterward, hiding the tool cards before the user could click one.

Both bugs were initially masked by test workarounds (calling `app.connect()` from the test helper, using a fallback `startToolSession()` call). The workarounds kept CI green while the product remained broken for real users on fresh machines.

## Decision

### 1. Fix the code, not the test

When a test discovers broken production behavior, fix the product. Never add workarounds in test code to compensate.

### 2. Tests validate behavior; they do not compensate for it

If a test must do something a real user would not (e.g., calling `app.connect()` because the app forgot to), the product has a bug.

### 3. Every test workaround is a hidden bug report

Comments like "fallback to programmatic call" or "bypass API fragility" must trigger a review: is the test covering for a real defect?

### 4. The CI pipeline is the quality gate

Tests must pass on fresh GitHub Actions runners with no pre-existing state. Fresh-machine reproducibility is a product correctness requirement, not just a testing concern.

## Enforcement

- **Code review**: Reviewers must flag test-side workarounds for product bugs.
- **CI**: E2E suite runs on fresh runners (ubuntu-latest + windows-latest). No persisted state.
- **Agent instructions**: Reference this ADR in `docs/agent-instructions/02-testing-and-validation.md`.

## Consequences

**Positive:** Bugs found by automated tests are fixed at the source. Test code stays focused on assertions.

**Negative:** Fixing the product takes longer than patching the test. Developers must resist "just get CI green" pressure.
