# Factory Protocol

The factory is an autonomous development loop that discovers work, builds features, reviews quality, and self-improves -- all without human intervention. It runs on its own branch and uses local testing instead of CI. This document covers how the factory works and what you need to know when operating within it.

Full protocol reference: `docs/factory/FACTORY_PROTOCOL.md`. Architecture decision: `docs/adrs/0015-autonomous-factory-protocol.md`.

## How It Works

The factory runs cycles via self-chaining one-shot crons. Each cycle completes before the next is scheduled -- no two cycles ever run concurrently.

A cycle follows this sequence:

1. **READ** -- Load state files (work queue, review queue, metrics)
2. **DECIDE** -- Select which pipelines to run based on queue contents
3. **DISPATCH** -- Spawn manager agents for each pipeline
4. **COLLECT** -- Gather structured reports from all managers
5. **WRITE** -- Update state files with results
6. **CHAIN** -- Schedule the next cycle (or terminate if convergence criteria are met)

The orchestrator is the sole writer of state files. This is Rule R1 -- no manager, no subprocess, no background task writes to state. Managers are stateless fresh agents that receive a self-contained brief and return a structured report.

## Agent-to-Manager Mapping

Factory managers map directly to the existing agent personas defined in `AGENTS.md`:

| Agent Persona | Factory Role | Responsibility |
|---------------|-------------|----------------|
| Researcher | Discovery Manager | Scans the codebase, issues, and specs to find work items. Populates the work queue. |
| Engineer | Build Manager | Implements a single work item. Runs the quality gate. Returns pass/fail with artifacts. |
| QA Reviewer | Review Manager | Performs adversarial code review on completed items. Classifies findings by severity. |
| Troubleshooter | Blocker Handler | Investigates BLOCKED items and test failures. Proposes fixes or escalates to human. |

Each manager receives a brief with: objective, scope, file list, constraints, and acceptance criteria. The manager does its work and returns a structured report. It does not read or write state files.

## Port Safety

All test infrastructure must use ports above 11000. This is a hard rule with no exceptions.

- The production dev server uses port 7777
- Ports below 11000 are reserved for human development
- Factory test servers, E2E browsers, and any spawned processes must bind to ports >11000
- Port safety is enforced by `docs/factory/checks/check-port-safety.js`

Before each cycle, a cleanup sweep kills orphaned processes on test ports. This prevents port conflicts from failed previous cycles. If a test server fails to start because the port is occupied, the factory kills the occupying process and retries once.

## Local Testing Override

Within the factory loop, all testing runs locally -- unit tests and E2E tests execute on the developer machine, not on GitHub Actions.

This overrides the CI-first mandate from `06-ci-first-testing.md` specifically for factory context. The rationale: the factory runs dozens of cycles, each producing testable code. Waiting for CI round-trips between cycles would make autonomous operation impractical.

Human-driven development continues to use CI as the source of truth. The factory's local testing is a scoped exception documented in `docs/adrs/0015-autonomous-factory-protocol.md`.

When a factory run completes and merges to main, CI runs the full suite as usual. Factory-produced code must pass CI before reaching production.

## Cost Awareness

Each cycle tracks its estimated token cost. The factory maintains a running total in `FACTORY_METRICS.md`.

Hard caps:

- **30 cycles maximum** per factory run
- **$50 ceiling** on total estimated token cost
- **5 consecutive idle cycles** triggers auto-termination (idle = no work items processed, no reviews completed)

The factory auto-terminates when any cap is hit. The orchestrator logs the termination reason and writes a final metrics summary.

Cost tracking is approximate -- it estimates based on token counts and model pricing. The estimates are conservative (they round up). The $50 ceiling provides a safety margin above the expected $30-40 cost of a typical productive run.

## Safety Rules

The factory must never compromise production code safety to satisfy its own optimization criteria.

**Protected code patterns** -- the factory never removes or weakens:

- Error handlers and catch blocks
- Input validation and boundary checks
- Defensive null/undefined guards
- Rate limiting and security middleware
- Path traversal prevention

The Simplicity Criterion (prefer shorter code when functionality is equivalent) applies to factory process code and new feature code. It never applies to existing safety code. A shorter function that drops error handling is not simpler -- it is broken.

No attribution markers of any kind appear in factory-produced code, commits, PRs, or documentation.

## E2E Test Rotation

Not all E2E tests run every cycle. Running the full suite every cycle is too slow and too expensive.

Rotation schedule:

| Cycle | What Runs |
|-------|-----------|
| Every cycle | Unit tests + prevention checks + security audit |
| Cycles 1, 2, 3, 4 | E2E subset (rotates through Playwright projects) |
| Every 5th cycle | Full E2E suite (all Playwright projects) |
| Before merge to main | Full E2E suite (mandatory) |

Tests that are skipped in the factory path:

- Visual regression tests (screenshot comparison is flaky across environments)
- Performance budget tests (local machine performance varies)
- Voice/STT tests (require hardware or emulation not available in factory context)

If a rotated E2E subset fails, the factory re-runs the failing project immediately before proceeding. A test failure does not skip to the next cycle -- it blocks until resolved or the item is marked BLOCKED.

## State Files

Factory state lives in `docs/factory/state/`. These files are committed to the factory branch and gitignored on main.

| File | Purpose | Writer |
|------|---------|--------|
| `WORK_QUEUE.md` | Pending work items with priority and status | Orchestrator only |
| `REVIEW_QUEUE.md` | Items awaiting adversarial review | Orchestrator only |
| `FACTORY_METRICS.md` | Cycle count, cost, pass/fail rates, timing | Orchestrator only |
| `state/cycles/cycle-{N}.md` | Per-cycle log (decisions, reports, outcomes) | Orchestrator only |
| `state/queue-details/{item-id}.md` | Detailed spec for each work item | Discovery Manager (via orchestrator) |

The orchestrator is the sole writer of all state files (Rule R1). Managers return reports; the orchestrator integrates them into state. This eliminates write conflicts and makes crash recovery deterministic -- the orchestrator reads the last written state and resumes.

Per-cycle log files (one file per cycle) replace a shared JSONL log. This avoids append races on Windows, where concurrent writers to a single file cause corruption.

## Convergence

The factory converges (decides to stop) when all of the following are true for 3 consecutive cycles:

- Work queue is empty (no pending items)
- Review queue is empty (no items awaiting review)
- Full E2E suite passes
- No items are in BLOCKED status

When convergence criteria are met, the orchestrator convenes a 3-expert termination panel:

1. **Systems engineer** -- Reviews architectural coherence of all factory-produced changes
2. **QA architect** -- Validates test coverage and quality gate integrity
3. **Cost engineer** -- Audits total spend and cost-per-item efficiency

Each expert receives a summary of the factory run (not the full codebase). If all three approve, the factory terminates. If any expert raises a Critical finding, the factory schedules additional cycles to address it.

## When You Are a Factory Manager

If you have been dispatched as a factory manager (Build Manager, Review Manager, Discovery Manager, or Blocker Handler), follow these rules:

1. **Your brief is self-contained.** It has everything you need. Do not explore beyond the files listed in your brief unless the brief explicitly says to.

2. **Do not modify state files.** Never write to `WORK_QUEUE.md`, `REVIEW_QUEUE.md`, `FACTORY_METRICS.md`, or any file in `state/cycles/`. The orchestrator handles all state. You return a report.

3. **Return a structured report.** Your report must include:
   - `STATUS`: success | partial | failed | BLOCKED
   - `FILES_CHANGED`: List of files you created or modified
   - `KEY_DECISIONS`: What you decided and why
   - `BLOCKERS`: What prevented completion (empty if STATUS is success)

4. **Respect port safety.** Any test server you start must bind to a port above 11000. Check your brief for the assigned port. If no port is assigned, use 11100 + a random offset.

5. **Respect safety code.** Never remove error handlers, catch blocks, validation code, or defensive checks. If the Simplicity Criterion suggests removing safety code, the Simplicity Criterion is wrong.

6. **Stay within scope.** If you discover work that exceeds your brief, return `STATUS: BLOCKED` with a description of the additional work needed. Do not ship undergated work.
