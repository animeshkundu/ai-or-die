# ADR-0015: Autonomous Factory Protocol for Local-First Development

## Status

**Accepted**

## Date

2026-03-22

## Context

The project needs an autonomous development loop that discovers work, builds features, reviews quality, and self-improves -- all without human intervention. Key constraints:

1. **Local testing**: All testing must run locally, not on CI. The factory operates on its own branch and cannot wait for GitHub Actions round-trips between cycles.
2. **Port safety**: Ports below 11000 must never be touched. The production dev server runs on port 7777 and must remain undisturbed during factory operation.
3. **Cost control**: The factory must track and cap its own costs. Unbounded autonomous loops are a cost hazard.
4. **Convergence**: The factory must terminate when convergence criteria are met, not run indefinitely.

An adversarial review by 3 independent experts (systems engineer, QA architect, cost engineer) identified 40 potential failure modes that informed the design. These include concurrent state corruption, orphaned test processes, cross-drive rename failures on Windows, append races on shared log files, and runaway cost accumulation.

## Decision

Adopt an adapted Autonomous Factory Protocol with these key choices:

### Cycle Execution
- **Self-chaining one-shot crons** for sequential cycle execution. Each cycle schedules the next only after completing. This prevents concurrent cycle races -- no two cycles ever overlap.

### Branch Strategy
- **Build-on-branch pattern**: Work happens on `factory/wip-{item}` branches. Code merges to the factory branch only after all quality gates pass. Failed builds never pollute the main working branch.

### Quality Gates
- **Local quality gates**: Unit tests + E2E subset rotation + prevention checks + security audit. All run locally within the factory cycle. This overrides the CI-first mandate from `06-ci-first-testing.md` specifically for factory context.

### Cost Tracking
- **Hard caps**: 30 cycles maximum, $50 ceiling. The factory auto-terminates on cost overrun or 5 consecutive idle cycles. Each cycle logs its estimated token cost.

### State Management
- **Per-cycle log files** instead of shared JSONL. Each cycle writes to `state/cycles/cycle-{N}.md`. This eliminates append races on Windows, where concurrent writers to a single file cause data corruption.
- **Same-directory temp files** for atomic writes. Temp files are created in the same directory as their target, then renamed. This avoids cross-drive rename failures (Q: drive to C: drive renames fail on Windows).

### Termination
- **Reduced termination panel**: 3 experts with summaries (systems engineer, QA architect, cost engineer), not 7 with full codebase context. This keeps termination evaluation fast and cost-effective.

### Safety
- **Safety code protection**: The factory never removes error handlers, catch blocks, validation code, or defensive checks. The Simplicity Criterion (prefer shorter code) applies to factory process code only, never to production safety code.
- **Local override of CI-first mandate** specifically within factory context. Human developers continue using CI as the authority per `06-ci-first-testing.md`.

## Consequences

### Positive

- Fully autonomous development loop that discovers, builds, reviews, and self-improves without human intervention
- Self-improving process -- each cycle can refine the factory protocol itself
- Crash-recoverable via state files -- the orchestrator reads state on startup and resumes from the last completed cycle
- Cost-bounded with hard caps on both cycles and dollar spend
- Adversarially reviewed design -- 40 failure modes identified and mitigated before deployment

### Negative

- Local resource consumption: Playwright browsers, test servers, and Node.js processes run on the developer machine during factory operation
- Cost per factory run estimated at $50-100 depending on work queue depth and cycle count
- Factory state files add to repo size on the factory branch (mitigated by gitignoring state files on main)

### Neutral

- Existing CI pipeline is unchanged -- factory operation does not modify `.github/workflows/`
- Human developers continue using the CI-first workflow per `06-ci-first-testing.md`
- Factory operates exclusively on its own branch (`factory/autonomous` and `factory/wip-*`)

## Notes

- Full protocol reference: `docs/factory/FACTORY_PROTOCOL.md`
- Agent integration guide: `docs/agent-instructions/10-factory-protocol.md`
- The CI-first mandate in `06-ci-first-testing.md` remains the standard for human-driven development; the factory's local testing is a specifically scoped override documented here and in the agent instruction
- Design informed by Karpathy's Autoresearch patterns: monotonic ratchet (quality never regresses), simplicity criterion (prefer shorter code), fixed time budget (capped cycles)
