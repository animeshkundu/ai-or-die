# Testing and Validation

## Core Philosophy

Validate like a user would use the product. Every test — from unit to E2E to exploratory — must ultimately answer the question: "Does this work the way a real person expects?" Tests that verify internal implementation details without connecting to user-observable behavior are maintenance liabilities, not safety nets.

## Testing Hierarchy

The project uses three testing tiers. Each tier serves a distinct purpose. Using the wrong tier for a given problem wastes time or misses bugs.

### Tier 1: True E2E Tests (Deterministic, CI)

Playwright tests that run on every PR across both Ubuntu and Windows. These are the source of truth for whether the product works. They simulate real user actions — clicking, typing, navigating — against the full running system (server, WebSocket, terminal, browser UI).

- **Run frequency**: Every commit, every PR
- **Authority**: If E2E passes on CI, the feature works. If it fails, the feature is broken.
- **Finds**: Regressions in known behavior, cross-platform breakage, integration failures
- **Owns**: The regression contract. Once an E2E test exists for a behavior, that behavior cannot break without CI catching it.

Every new feature requires E2E coverage. Every bug fix requires a regression E2E test. No exceptions.

See `docs/agent-instructions/06-ci-first-testing.md` for the complete CI workflow, job map, and debugging playbook.

### Tier 2: Copilot Agent Exploratory Testing (LLM, Periodic)

Copilot coding agents with Playwright MCP acting as human-like testers. They browse the app, interact with it at various viewports, and produce structured audit reports. This is a "bug bash" — run per feature, per release, or per major UI change. Not on every commit.

- **Run frequency**: Per feature or per release (~50 minutes per run)
- **Authority**: Findings require expert validation before action (~15% false-positive rate from emulation gaps)
- **Finds**: Unknown-unknowns, UX issues, accessibility gaps, mobile layout problems, edge cases nobody anticipated
- **Owns**: Discovery. These tests find the things you forgot to test.

Validated findings become fix tasks. Fixes include Tier 1 E2E regression tests that prevent recurrence.

See `docs/agent-instructions/09-copilot-agent-testing.md` for the full setup, issue templates, and validation process.

### Tier 3: Manual Device Testing (Real Hardware, Edge Cases)

Real devices, real keyboards, real network conditions. For issues that Playwright emulation cannot catch.

- **Run frequency**: As needed, for findings flagged "Needs Real Device Testing" during Tier 2 validation
- **Authority**: Final word on device-specific behavior
- **Finds**: `visualViewport` timing, `pointer: coarse` media query behavior, virtual keyboard overlays, PWA install flows, touch physics, real network latency
- **Owns**: The gap between emulation and reality

Any Tier 2 finding that depends on real device behavior must be verified on Tier 3 before the fix ships.

### How the Tiers Work Together

1. **Tier 2 discovers issues** during feature development or before a release
2. **Expert validation** removes false positives and confirms real bugs
3. **Tier 3 verifies** any finding that depends on real device behavior
4. **Fixes ship with Tier 1 E2E regression tests** that run on every future commit
5. **Tier 1 prevents recurrence** permanently

The tiers are complementary, not competing. Tier 1 catches what you know about. Tier 2 finds what you missed. Tier 3 confirms what emulation cannot.

## Coverage Target

Target 90% code coverage for all new code. This is not optional for new features or refactors. Existing code without tests should be covered when modified.

## Test-Driven Approach

Write tests alongside implementation, not after. The workflow:

1. Write the test describing expected behavior
2. Implement the code to make the test pass
3. Refactor if needed, keeping tests green

## Test Framework

- **Framework**: Mocha with Node.js built-in `assert`
- **Location**: `test/` directory
- **Naming**: `name.test.js`
- **Running**: `npm test`

## Test Guidelines

- Write fast, isolated unit tests
- Avoid network calls and real CLI spawning in tests — mock process spawns
- Use temp directories for file system tests (see `session-store.test.js` pattern)
- Test cross-platform behavior: path construction, command resolution, shell detection

## CI-Only Testing

All testing happens on GitHub Actions runners. No local test runs. Ever.

- Local environments are unreliable: missing native modules, stale state, platform differences
- CI provides fresh, reproducible, cross-platform results every time
- E2E tests are the only true validation — if they pass on CI, the feature works

The workflow: write code → push to branch → open draft PR → CI runs → read results → fix → push again.

See `docs/agent-instructions/06-ci-first-testing.md` for the complete CI workflow guide, job map, and debugging playbook.

## Self-Validation

Before committing, every agent must:

1. Push to branch and open a draft PR to trigger CI
2. Verify all CI jobs pass on both ubuntu-latest and windows-latest
3. Check `docs/history/` for known issues if any job fails
4. Verify the change doesn't break existing functionality (CI confirms this)

## What to Test

### For Bridge Changes
- Command discovery on mock file systems
- Session lifecycle (start, input, resize, stop)
- Error handling (command not found, process crash)
- Platform-specific paths

### For Server Changes
- REST API responses (status codes, JSON structure)
- WebSocket message handling
- Session creation and deletion
- Auth middleware behavior

### For Client Changes
- E2E tests via Playwright (verified on CI, never locally)
- Mobile viewport tests via mobile-iphone and mobile-pixel Playwright projects
- WebSocket reconnection covered by E2E functional tests

## When Tests Fail

If tests fail, fix them before moving on. Do not:
- Skip failing tests
- Comment out assertions
- Reduce coverage to make the build pass
- Commit with known failures
