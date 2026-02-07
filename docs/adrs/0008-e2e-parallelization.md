# ADR-0008: E2E Test Parallelization Strategy

## Status

**Accepted**

## Date

2026-02-07

## Context

The E2E test suite has grown to 16 spec files across 6 Playwright projects. The `functional` project — containing tests 02-07, 09-image-paste, and 09-background-notifications — runs approximately 30 tests sequentially with `workers: 1`. On GitHub Actions runners, this takes 7-15 minutes per platform, exceeding the 7-minute performance budget for CI feedback loops.

Fast CI feedback is critical because all testing happens exclusively on GitHub runners (no local testing). The push → CI → fix → push cycle must be fast enough that agents can iterate efficiently.

## Decision

Split the functional test group into two sub-groups and enable parallel workers in CI:

### Test Split
- **`functional-core`**: Tests `02-terminal-io`, `03-clipboard`, `04-context-menu`, `05-tab-switching` (core terminal interaction features)
- **`functional-extended`**: Tests `06-large-paste`, `07-vim-and-session`, `09-image-paste`, `09-background-notifications` (extended features and cross-cutting concerns)

### Parallel Workers
- Set `workers: process.env.CI ? 2 : 1` in `e2e/playwright.config.js`
- CI runs 2 Playwright workers per job for parallel test execution
- Local development retains 1 worker for debugging simplicity (though local testing is not the primary workflow)

### CI Pipeline Changes
- Replace single `test-browser-functional` job with two: `test-browser-functional-core` and `test-browser-functional-extended`
- Each runs independently and in parallel with all other browser test jobs
- Each uploads artifacts with distinct names for failure diagnosis

### Why this works
- Each test already creates its own server instance via `createServer()` with an ephemeral port (port 0)
- Sessions are per-server, eliminating cross-test state contamination
- Playwright provides browser context isolation between parallel tests
- No shared filesystem resources detected in the test suite

## Consequences

### Positive

- No CI job exceeds 7 minutes — faster feedback for the push-fix-push workflow
- More granular job names in CI (functional-core vs functional-extended) aid debugging — agents can immediately see which category of tests failed
- Parallel workers within jobs further reduce wall-clock time
- Sets a pattern for future test group splits as the suite grows

### Negative

- More CI jobs to monitor (6 browser test job types instead of 5, plus unit tests and build-binary)
- Artifact names become longer and more numerous
- If test isolation assumptions prove wrong, parallel execution could introduce flakiness (mitigated by the existing ephemeral-port pattern)

### Neutral

- Existing test files require no code changes — only configuration and CI workflow updates
- The `workers: 2` setting is conservative and can be increased if runners have sufficient resources

## Notes

- When any job approaches 6 minutes consistently, split it further
- When the test suite exceeds 80 tests, re-evaluate the overall split strategy
- Monitor for flaky tests that may indicate parallel execution issues
