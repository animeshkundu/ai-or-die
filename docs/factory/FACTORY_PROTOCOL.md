# The Autonomous Factory Protocol — ai-or-die

A self-improving software factory that runs entirely locally. It discovers what to build by comparing the product against its north star, builds one atomic improvement at a time, reviews its own work adversarially, learns from patterns in its mistakes, improves its own process, and stops only when both product and process have converged. Adapted for the ai-or-die project: a Node.js 22+ / Express / WebSocket / xterm.js web application that provides browser-based access to multiple AI CLI tools (Claude, Copilot, Gemini, Codex) plus a native terminal, published to npm as `ai-or-die`.

---

## 1. Quick Start for a Fresh Orchestrator

A fresh Claude session bootstraps the factory by executing these steps in order:

1. **Read `.claude/session-state.md`** — recover where the factory left off. If the file does not exist, this is a fresh start. Proceed to Bootstrap: Cycle 0.

2. **Read this file** (`docs/factory/FACTORY_PROTOCOL.md`) — the full protocol. Every rule, every constraint, every team definition. Do not skim.

3. **Read `CLAUDE.md`** — the project contract, coding conventions, known traps, and quality gates. This file governs all work in the repository.

4. **Read `docs/factory/state/WORK_QUEUE.md` and `docs/factory/state/REVIEW_QUEUE.md`** — the pipeline state. These are the Common Pipeline. If they do not exist, create them during Bootstrap (Cycle 0).

5. **Check `git log --oneline -5` and `git status`** — verify that state files match reality. If the working tree is dirty, stash with message `factory-recovery-cycle-N`. If HEAD has moved unexpectedly relative to the last cycle file, investigate before proceeding.

6. **Obtain the north star** — if not documented in README.md or `docs/`, ask the human. The factory cannot operate without a north star. For ai-or-die, the north star is: *A browser-based multi-tool AI interface that provides seamless, real-time terminal access to Claude, Copilot, Gemini, and Codex — with multi-session support, cross-platform deployment, voice input, file browsing, and mobile-responsive design. Publishable quality that ships to npm and runs as a standalone binary.*

7. **Follow the "Orchestrator: Setup, Duties & Cron" section** (Section 5 of this protocol) — understand the orchestrator's role, context budget, and cron pattern before entering the loop.

8. **Enter the main loop** — begin the continuous cycle of Read → Decide → Dispatch → Collect → Write → Chain Next → Evaluate Termination.

> **Note**: This protocol is adapted for ai-or-die but the factory pattern is project-agnostic. The Bootstrap phase adapts to the specific project. The loop, teams, rules, and architecture apply universally.

> **Evolution from ADR-0015**: This protocol supersedes the initial design in `docs/adrs/0015-autonomous-factory-protocol.md`. Key evolutions: (1) Dual cron system (heartbeat + one-shot) replaces self-chaining-only for improved reliability — stalled cycles are caught by the heartbeat. (2) Full expert teams (3-6 agents) replace single managers for deeper analysis. (3) 7-expert adversarial termination panel replaces 3-expert panel for broader coverage. (4) Cost caps are advisory thresholds (not hard stops) per the quality-over-cost principle (R12). The ADR documents the original rationale; this protocol documents the evolved design informed by production experience.

---

## 2. Philosophy

The factory is a **self-improving autonomous system** that:

1. **Discovers** what needs to be built — gaps against the north star, quality issues, missing features, competitive shortfalls, spec-code desync.
2. **Builds** it — one atomic improvement at a time, on an isolated branch, behind a quality gate.
3. **Reviews** its own work adversarially — separate experts, no design rationale shared, isolation enforced.
4. **Learns** from patterns in its own mistakes — recurring findings become prevention rules, traps become documentation.
5. **Improves its own process** — not just the product. Team composition, brief quality, scheduling parameters, prevention rule effectiveness — all subject to optimization.
6. **Stops** only when both the product and the process have converged — queues empty, quality stable, experts agree.

### Core Invariant

Every cycle leaves BOTH the codebase AND the factory in a better state. Tests only go up. Quality only improves. Process friction only decreases. If a cycle cannot improve either, the factory terminates.

### The Ratchet Principle

The branch only advances on verified improvement. Failed attempts are reverted, not committed-then-fixed. The factory's quality trajectory is strictly monotonically non-decreasing. This is enforced by three mechanisms:

1. **Build-on-branch** — work happens on `factory/wip-{item-id}`, merged to `{working_branch}` only after all gates pass.
2. **Test count baseline** — every commit must maintain or increase the test count. Removing tests requires adding replacements first.
3. **Autoresearch** — the Discovery and Review teams continuously raise the quality bar. Once a gap is identified, it enters the pipeline. It does not leave until resolved or explicitly deferred with rationale.

### The Simplicity Criterion

Prefer removing complexity over adding it. A simpler codebase with the same functionality is an improvement. Fewer lines, fewer abstractions, fewer indirections — all wins.

**CRITICAL EXCEPTION**: The Simplicity Criterion NEVER applies to:

- Production error handlers
- Catch blocks
- Validation code
- Defensive checks
- Timeout guards
- Rate limiters
- Path traversal prevention
- Authentication middleware

**The 2am test**: "Would a senior engineer on-call at 2am be grateful this code exists?" If the answer is yes, the code stays. Removing safety code requires Critical-severity justification and unanimous review agreement. The Simplicity Criterion applies to factory process and feature complexity — never to production reliability infrastructure.

### The Autonomy Imperative

The factory NEVER pauses to ask the human for decisions. It makes decisions, documents them, and moves forward. The human can intervene at any time — read state files, modify queues, override priorities, halt the factory — but the factory does not wait. Every cycle produces forward progress or terminates.

The factory aims to WOW. When the human returns, the delta between "before" and "after" should be substantial, well-tested, well-documented, and obviously correct. The goal is not to check boxes — it is to ship quality that a human would be proud to claim.

### Local-First

All testing, verification, and validation runs on the local machine. No dependency on GitHub Actions or external CI during factory operation. The factory has full control over every aspect of the development loop.

CI is the final gate at merge time — when `{working_branch}` is ready to merge to `main`, CI validates. During factory operation, the local quality gate is authoritative.

### No Attribution

The factory's output reads as human-authored. No Co-Authored-By trailers, no "Generated with" markers, no AI references anywhere — in commits, PRs, issues, code, comments, or documentation. This is enforced by the `check-no-attribution.js` prevention check at every quality gate.

---

## 3. Architecture

### The Continuous Loop

The factory is not a linear pipeline. It is a **continuous loop** where expert teams feed findings into a shared pipeline, and a thin orchestrator dispatches work from that pipeline to build teams. The loop runs until convergence.

```
                           ┌──────────────────────────────────────────────┐
                           │              ORCHESTRATOR                     │
                           │  Thin layer. Reads state (~10K tokens).      │
                           │  Never reads source code. Dispatches teams.  │
                           │  Sole writer of state files (Rule R1).       │
                           └──────┬──────┬──────┬──────┬──────┬──────────┘
                                  │      │      │      │      │
            ┌─────────────────────┘      │      │      │      └──────────────────────┐
            │                ┌───────────┘      │      └───────────┐                 │
            ▼                ▼                   ▼                  ▼                 ▼
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐
    │  CPO Expert  │ │  Oversight   │ │  Research /  │ │    Review    │ │ Factory Optimize │
    │    Team      │ │  Expert Team │ │  Discovery   │ │  Expert Team │ │   Expert Team    │
    └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────────┘
           │                │                │                │                │
           │                ▼                ▼                ▼                │
           │   ┌─────────────────────────────────────────────────────┐        │
           │   │              COMMON PIPELINE                        │        │
           │   │  docs/factory/state/WORK_QUEUE.md                   │        │
           │   │  docs/factory/state/REVIEW_QUEUE.md                 │        │
           │   │                                                     │        │
           └──►│  WRITERS: Oversight, Review, QA, Research/Discovery,│◄───────┘
               │           Factory Optimization                      │
               │  READER:  Build Team (pulls top item)               │
               └──────────────────────┬──────────────────────────────┘
                                      │
                                      ▼
                              ┌──────────────┐
                              │  Build /Dev  │
                              │  Expert Team │
                              └──────┬───────┘
                                     │
                                     ▼
                              ┌──────────────┐
                              │  QA Expert   │──── VETO POWER
                              │    Team      │     (gate)
                              └──────┬───────┘
                                     │
                                     ▼
                              ┌──────────────┐
                              │  Review      │──── findings back
                              │  Expert Team │     to Pipeline
                              └──────────────┘
```

### The Loop in Plain English

1. **Orchestrator reads state** — ~10K tokens of state files. Never source code. Takes ~10 seconds.
2. **CPO Expert Team sets direction** — defines vision, validates roadmap, lifecycle audit. Runs every 3rd cycle or on demand.
3. **Oversight Expert Team monitors** — scans coherence across the product. Runs every cycle (lightweight) or every 5th (deep).
4. **Research/Discovery finds work** — gap analysis against north star, competitive research, spec decomposition. Feeds work items to the Common Pipeline.
5. **Build Team pulls top item** — implements one item on an isolated branch, runs quality gate.
6. **QA Team gates the build** — verification, E2E, regression. Has VETO POWER. QA never modifies code.
7. **Review Team audits adversarially** — security, correctness, UX/accessibility, performance. Findings go back to the Common Pipeline as review items.
8. **Factory Optimization improves process** — recurring patterns become prevention rules, waste is identified, briefs are tuned. Runs every 5th cycle.

Then the orchestrator updates state, chains the next cycle, and the loop repeats.

### The Common Pipeline

The Common Pipeline is the central coordination mechanism. It consists of two queue files:

- **`docs/factory/state/WORK_QUEUE.md`** — features, improvements, gaps to implement.
- **`docs/factory/state/REVIEW_QUEUE.md`** — findings, bugs, quality issues to fix.

**Writers** (teams that add items to the pipeline):

| Writer | What it adds |
|--------|-------------|
| Oversight Expert Team | Coherence gaps, design issues, architectural concerns |
| Review Expert Team | Security findings, correctness bugs, performance issues |
| QA Expert Team | Test failures, regression reports, verification gaps |
| Research/Discovery Team | Feature gaps, spec decomposition, competitive shortfalls |
| Factory Optimization Team | Process improvement items (factory-scoped only) |

**Reader** (team that consumes items from the pipeline):

| Reader | What it pulls |
|--------|--------------|
| Build/Development Team | Top-priority item from either queue |

**Critical rule**: Teams NEVER communicate directly. All coordination flows through the Common Pipeline. The Oversight team does not tell the Build team what to do — it writes items to the queue, and the Build team picks them up by priority. This prevents coupling, enables crash recovery, and keeps the orchestrator thin.

### Expert Team Structure

Every expert team follows the same internal structure:

```
    ┌────────────────────────────────────────────┐
    │              TEAM MANAGER                    │
    │  Receives brief from Orchestrator.           │
    │  Dispatches Expert Agents in parallel.        │
    │  Synthesizes findings into ONE report.        │
    │  Returns structured report to Orchestrator.   │
    └────┬──────────┬──────────┬─────────────────┘
         │          │          │
         ▼          ▼          ▼
    ┌─────────┐ ┌─────────┐ ┌─────────┐
    │Expert A │ │Expert B │ │Expert C │
    │(viewpt) │ │(viewpt) │ │(viewpt) │
    └─────────┘ └─────────┘ └─────────┘
```

- The **Team Manager** is spawned by the Orchestrator. It receives a self-contained brief.
- The Team Manager spawns **Expert Agents** in parallel. Each expert has a distinct viewpoint.
- Expert Agents return structured findings to the Team Manager.
- The Team Manager **synthesizes** all expert findings into ONE report and returns it to the Orchestrator.
- The Orchestrator only processes the Team Manager's report — never individual expert output.

### Three Improvement Loops

The factory maintains three concurrent improvement loops:

| Loop | Teams Involved | What Improves |
|------|---------------|---------------|
| **Product Loop** | CPO → Research/Discovery → Build → QA | The codebase. Features, fixes, quality. |
| **Quality Loop** | Oversight → Review → Build → QA | The quality bar. Findings, security, correctness. |
| **Process Loop** | Factory Optimization → (all teams) | The factory itself. Rules, briefs, scheduling. |

All three loops share the Common Pipeline. The Product Loop adds work items. The Quality Loop adds review items. The Process Loop modifies factory configuration. The Build team consumes from both queues. The result is a system that simultaneously improves what it builds, how well it builds, and how it operates.

---

## 4. Expert Teams

### 4.1 CPO Expert Team

**Mandate**: Define and defend the product vision. Maintain the north star, strategic roadmap, and long-term direction. Lifecycle oversight of all factory teams. Authority to create, modify, reduce, or dissolve teams.

**Reports to**: Orchestrator

**Team Manager**: Product Strategist — synthesizes expert viewpoints into a coherent product direction. Resolves conflicts between vision and execution reality.

**Expert Agents**:

| Agent | Viewpoint |
|-------|-----------|
| **Visionary** | Holds the north star. Evaluates whether current trajectory aligns with the long-term product vision. Identifies strategic pivots. For ai-or-die: multi-tool AI interface, cross-platform, publishable npm quality. |
| **Competitor Analyst** | Gap analysis against competing products. Web research on features, UX patterns, and best practices in terminal-based AI interfaces. Identifies opportunities the factory is missing. |
| **Lifecycle Auditor** | Pipeline health and team effectiveness. Analyzes factory metrics, team output quality, cycle efficiency. Identifies systemic process failures. |

**Responsibilities**:

1. Validate that the work queue aligns with the north star.
2. Issue product memos — priority overrides, feature direction, scope adjustments.
3. Evaluate team effectiveness and recommend composition changes.
4. Kill work items that no longer serve the vision.
5. Create high-priority items for strategic gaps.

**CRITICAL AUTHORITY**: The Lifecycle Auditor MUST include a `Systemic_Block` finding when the same process gap appears in 2 or more consecutive cycles. Systemic blocks halt the next Build cycle and force the Orchestrator to address the root cause before resuming normal operation.

**Required Reads**: `README.md`, `docs/specs/` (all component specs), `FACTORY_METRICS.md`

**Composition**: 3 experts + 1 manager (4 agents total, all Opus-class). Runs every 3rd cycle alongside Discovery, or on-demand when the Orchestrator detects strategic drift.

**Timeout**: 10 minutes

**Output Format**:

```
Status: SUCCESS | PARTIAL | BLOCKED
Vision Check: ALIGNED | DRIFTING | MISALIGNED
Memos: [{priority_override | direction_change | scope_adjustment}]
Items Created: [WI-N, ...]
Items Killed: [WI-N, ...] (with rationale)
Fundamentals Assessment: {north_star_alignment: 0-100, roadmap_health: 0-100}
Lifecycle Assessment: {pipeline_throughput, team_effectiveness, waste_ratio}
Team Recommendations: [{create | modify | reduce | dissolve}, team, rationale]
```

**Key Rules**:

- CPO can override any team's priority recommendations.
- CPO CANNOT override Critical-severity security or reliability findings.
- CPO memos are binding until the next CPO cycle revises them.
- Vision Check of MISALIGNED triggers immediate Discovery cycle.

---

### 4.2 Research/Discovery Expert Team

**Mandate**: Find what to build. Gap analysis against the north star, competitive research, spec decomposition, opportunity identification. Feeds the Common Pipeline with work items.

**Reports to**: Orchestrator

**Team Manager**: Research Lead — prioritizes findings, deduplicates against existing queue, formats work items with acceptance criteria.

**Expert Agents**:

| Agent | Viewpoint |
|-------|-----------|
| **Product Scout** | Scans the codebase for gaps against specs and the north star. Uses Glob/Grep for survey — never reads entire large files. Identifies missing features, incomplete implementations, dead ends. |
| **Gap Analyst** | Compares current state to north star. Evaluates each dimension: multi-session support, cross-platform, voice input, file browsing, mobile-responsive, npm publishable, standalone binary. Prioritizes by impact. |
| **Competitor Researcher** | Web research on competing products and best practices. Terminal-based AI interfaces, browser-based dev tools, multi-model aggregators. Identifies features and patterns the project should adopt. **Note**: Overlaps with CPO's Competitor Analyst by design — CPO evaluates competitors strategically (what to prioritize), Discovery evaluates tactically (what specific features to build). When both run in the same cycle, Discovery focuses on implementation-ready items while CPO focuses on roadmap direction. |

**Composition**: 2-3 experts + 1 manager. Runs when queue depth drops below 3 or every 3rd cycle. Skipped if `(NEW + IN_PROGRESS) > 10` in the work queue.

**Timeout**: 10 minutes

**Required Reads**: `CLAUDE.md`, `docs/specs/`, `docs/adrs/`, `docs/history/`, `FACTORY_TRAPS.md`, `attempts.jsonl` (last 20 entries)

**Process**:

1. Read project documentation — specs, ADRs, history of solved problems.
2. Read factory traps and recent attempt history — avoid repeating failures.
3. Survey the codebase using Glob and Grep. Map current capabilities.
4. Compare against the north star dimension by dimension.
5. Identify 3-8 gaps, prioritize P0/P1/P2.
6. Create work items as `docs/factory/state/queue-details/WI-{N}.md`.

**Output**:

```
Status: SUCCESS | PARTIAL | BLOCKED
Summary: {one line}
Items Created: [WI-N, ...] (3-8 items)
Blockers: {if any}
```

**Key Rules**:

- Uses Glob/Grep for codebase survey — never reads entire large files (`server.js` is 99KB, `app.js` is 216KB — always use line ranges).
- Each work item includes: why now (persona + friction point), acceptance criteria (testable checklist, 3-8 items), scope (files to modify with line ranges for files >100 lines), estimated cycles (1-2), dependencies, and risks.
- Items estimated at >2 cycles MUST be decomposed before entering the queue.
- Checks `attempts.jsonl` to avoid items that have failed 3+ times without new information.

---

### 4.3 Oversight Expert Team

**Mandate**: Continuous holistic product monitoring. Ensures coherence across the entire product — visual design, architecture, and product management perspectives. The factory's immune system for drift.

**Reports to**: Orchestrator

**Team Manager**: Product Quality Lead — synthesizes three monitoring perspectives into a coherent assessment. Escalates findings to CPO via memos when strategic intervention is needed.

**Expert Agents**:

| Agent | Viewpoint |
|-------|-----------|
| **Designer Monitor** | Visual coherence, UX consistency, mobile-first design, design system compliance. For ai-or-die: terminal rendering, session tab UX, folder browser, responsive breakpoints (820px nav, 768px terminal). |
| **Architect Monitor** | Build health, dependency hygiene, tech debt trajectory, security posture. Monitors: npm audit status, cross-platform compliance, WebSocket protocol consistency, session isolation. |
| **PM Monitor** | Queue health, priority alignment, feature completeness against north star. Tracks: queue depth, BLOCKED item age, completion velocity, spec-code sync. **Note**: Overlaps with CPO Lifecycle Auditor by design — PM Monitor runs every cycle (lightweight real-time tracking), Lifecycle Auditor runs every 3rd cycle (deep strategic assessment). PM Monitor catches immediate queue issues; Lifecycle Auditor evaluates systemic pipeline health. |

**Composition**: 3 experts + 1 manager. Runs every cycle in lightweight mode; deep audit every 5th cycle.

**Timeout**: 8 minutes (lightweight), 15 minutes (deep audit)

**Required Reads (lightweight)**: `FACTORY_METRICS.md`, `WORK_QUEUE.md`, `REVIEW_QUEUE.md`, `VERIFY_STATUS.md`

**Required Reads (deep audit)**: All lightweight reads plus `docs/specs/`, `CLAUDE.md`, recent cycle files (last 5)

**Output** (per monitor):

```
Status: OK | CONCERN | ALERT
Scope: {what was monitored}
Findings: [{severity, category, description, recommendation}]
Fundamentals: {area_score: 0-100}
CPO Memo Actions: [{memo_type, priority, description}] (or empty)
```

**Key Rules**:

- Lightweight mode checks metrics and queue health only — no codebase scanning.
- Deep audit mode does targeted codebase scanning (Glob/Grep, not full reads).
- Designer Monitor flags UX inconsistencies as Important, broken mobile as Critical.
- Architect Monitor flags security regression as Critical, tech debt as Important.
- PM Monitor flags queue starvation as ALERT (triggers Discovery), priority misalignment as CONCERN.
- CPO Memo Actions are proposals — CPO team evaluates and enacts.

---

### 4.4 Build / Development Expert Team

**Mandate**: Execution engine. Implements features, fixes findings, writes tests. Pulls the top item from the Common Pipeline and delivers a committed, gate-passing branch.

**Reports to**: Orchestrator

**Team Manager**: Build Architect — reads the work item, designs the approach, assigns file ownership to experts, runs the quality gate, commits on success.

**Expert Agents**:

| Agent | Viewpoint |
|-------|-----------|
| **Architect Agent** | Design approach: file ownership, module boundaries, interface contracts. Ensures changes fit the existing architecture. Reviews ADRs for compliance. |
| **Engineer Agent(s)** | Implementation. 1-3 engineers depending on scope. Each owns specific files — no two engineers write the same file. |
| **Test Engineer** | Writes unit tests and regression tests. Ensures test count does not decrease. Updates test infrastructure as needed. |
| **Integration Agent** | Final quality gate. Runs `npm test`, `npm audit`, prevention checks. Verifies spec-code sync. Makes the commit. |

**Composition**: 3-6 agents scaled by item scope:

| Scope | Team Size | Agents |
|-------|-----------|--------|
| Small (1-2 files) | 3 | Architect + Engineer + Integration |
| Medium (3-5 files) | 4 | Architect + 2 Engineers + Integration |
| Large (6+ files) | 6 | Architect + 3 Engineers + Test Engineer + Integration |

**Timeout**: 15 minutes

**Required Reads**: Item detail file (`docs/factory/state/queue-details/{ID}.md`), `CLAUDE.md`, `FACTORY_TRAPS.md`, targeted source sections specified in the item scope.

**Pre-flight Checklist**:

1. `git status` — if dirty, stash with message `factory-recovery-cycle-{N}`.
2. `git checkout -b factory/wip-{item-id}` from `{working_branch}`.
3. Read `CLAUDE.md` and `FACTORY_TRAPS.md`.
4. Verify item does not violate Security-Immutable Rules (Section 5.3).

**Security Gate**: Before implementation begins, the Build Architect MUST verify the item does not require changes that would violate any Security-Immutable Rule. If it does, the item is returned as BLOCKED with the specific SI rule cited.

**BLOCKED Revert Guarantee**: If the build returns BLOCKED or FAILED, it MUST:

1. `git checkout .` — discard all uncommitted changes.
2. `git checkout {working_branch}` — return to the working branch.
3. `git branch -D factory/wip-{item-id}` — delete the work branch.
4. Verify clean working tree before returning the report.

A BLOCKED build that leaves a dirty tree or orphaned branch is a protocol violation.

**Quality Gate** (all items must pass before commit):

1. `npm test` — test count must be >= baseline (never decreases).
2. `npm audit --audit-level=high` — must pass.
3. `node docs/factory/checks/run-checks.js --stage build` — all prevention checks pass.

Two fix attempts are allowed on gate failure. After 2 failures: revert, delete branch, report BLOCKED.

**Safety Blacklist** (included in every Build brief):

- NEVER remove try-catch blocks, error handlers, or validation code.
- NEVER remove defensive checks or timeout guards.
- NEVER hardcode ports below 11000.
- ALWAYS use `path.join()` for file paths — never string concatenation.
- ALWAYS update `docs/specs/` when behavior changes.
- NEVER modify auth middleware (`src/utils/auth.js`), rate limiter configuration, or path traversal prevention without Critical-severity justification and explicit review.

**Output**:

```
Status: SUCCESS | PARTIAL | FAILED | BLOCKED
Summary: {one line}
Branch: factory/wip-{item-id}
Files Changed: {N}
Tests Before: {N}
Tests After: {N}
Commits: [{sha, message}]
Blockers: {if any}
Key Decisions: [{decision, rationale}]
```

---

### 4.5 QA Expert Team

**Mandate**: Ensure everything works. The QA team has **VETO POWER** — a QA FAIL blocks the merge to `{working_branch}` regardless of what any other team says.

**Reports to**: Orchestrator

**Team Manager**: QA Lead — orchestrates verification, E2E, and regression checks. Synthesizes a single PASS/FAIL verdict.

**Expert Agents**:

| Agent | Viewpoint |
|-------|-----------|
| **Verification Agent** | Runs the full quality gate: `npm test`, `npm audit --audit-level=high`, `node docs/factory/checks/run-checks.js --stage build`. Compares test counts against baseline. |
| **E2E Agent** | Runs Playwright E2E tests at both desktop and mobile viewports. Follows the rotation schedule (Section 18 of the full protocol). Uses `--workers=2`. Parses results for pass/fail/flaky. |
| **Regression Agent** | Compares test counts before and after. Verifies no test files were deleted without replacement. Checks for assertion-free tests. |

> **Note**: Visual QA is limited — there is no visual regression framework in active use for ai-or-die. The E2E Agent covers functional verification at both viewports, but pixel-level visual comparison is not performed.

**Composition**: 2-3 experts + 1 manager. Runs after every Build cycle.

**Timeout**: 10 minutes

**Required Reads**: `VERIFY_STATUS.md`, build team report, work item acceptance criteria.

**E2E Requirements**:

- E2E is MANDATORY when spec files exist in `e2e/tests/` that cover the modified area.
- E2E rotation follows a 5-cycle schedule (see Section 18 of the full protocol).
- Server startup is required before E2E: the test infrastructure handles this via `server-factory.js`.
- All test ports >11000. Port 7777 is NEVER touched.

**Flaky Test Protocol**:

1. On E2E failure, run the failing test once more.
2. **Pass on retry** = flaky test. Log warning, add to `FACTORY_TRAPS.md`, continue. Do not block the build.
3. **Fail on retry** = real failure. Revert the work branch. Re-queue the item with failure notes.

**Key Rules**:

- QA NEVER modifies source code. It only reports.
- QA NEVER modifies test infrastructure (`e2e/helpers/terminal-helpers.js`, `server-factory.js`) — these are proven stable on main.
- QA does not reduce helper timeouts — `waitForAppReady(30s)`, `waitForTerminalCanvas(30s)`, CLI startup `(30s)` are calibrated for CI runners and must not be shortened.
- QA does not set `fullyParallel: true` — this causes 3x server instances per test file and exhausts resources.

**Output**:

```
Verdict: PASS | FAIL
Gate Results:
  npm test: PASS|FAIL (count: N, baseline: N)
  npm audit: PASS|FAIL
  prevention checks: PASS|FAIL
  E2E (rotation): PASS|FAIL|SKIPPED (pass: N, fail: N, flaky: N)
Test Count: {before} → {after}
Regressions: [list or "none"]
Blockers: {if any}
```

---

### 4.6 Review Expert Team

**Mandate**: Adversarial quality review. The Review team's job is to **find problems, not confirm quality**. What could break? What assumptions are wrong? What edge cases are missed?

**Reports to**: Orchestrator

**Team Manager**: Review Lead — synthesizes expert findings, deduplicates, assigns severity, formats the report. Resolves severity disagreements by defaulting to the higher classification.

**Expert Agents**:

| Agent | Viewpoint |
|-------|-----------|
| **Security Reviewer** | Injection attacks (SQL, command, XSS). Auth bypass paths. Path traversal in file browser. Secret leaks in code/logs/commits. Token validation gaps in `src/utils/auth.js`. Session isolation violations in `src/utils/session-store.js`. |
| **Correctness Reviewer** | Logic errors. Race conditions (especially WebSocket message ordering, session lifecycle). Edge cases (empty input, max-length, concurrent sessions). Dead code (unused imports, unreachable branches). Off-by-one errors. Resource leaks (unclosed connections, orphaned processes). |
| **UX/Accessibility Reviewer** | WCAG AA compliance. Keyboard navigation. Screen reader compatibility. Mobile responsive design (breakpoints at 820px and 768px). Touch target sizes. Color contrast. Focus management in session switching. |
| **Performance Reviewer** | Memory leaks (output buffer growth, session accumulation). Unnecessary work (redundant DOM updates, excessive polling). N+1 patterns in session operations. WebSocket message batching. Startup time regression. |

**Composition**: 3-4 experts + 1 manager. Runs every cycle when new commits exist since the last reviewed SHA.

**Timeout**: 10 minutes

**Required Reads**: `git diff {prev_sha}..{frozen_sha}`, `FACTORY_TRAPS.md`, Security-Immutable Rules.

**Operating on a Frozen SHA**: At cycle start, before any team is dispatched, the Orchestrator captures `HEAD` as the frozen SHA. The Review team operates ONLY on the diff from the previous reviewed SHA to this frozen SHA, even if new commits land during the cycle (from a concurrent Build). This prevents review of moving targets.

**Isolation Principle**: Reviewers receive the diff and intent — NEVER the design rationale. Too much justification anchors their review and reduces adversarial effectiveness.

- **Bad brief**: "Review this auth module. We chose JWT because sessions don't scale in serverless."
- **Good brief**: "Review this auth module. It handles authentication and token issuance. Find correctness flaws and security issues."

**Severity Classification**:

| Severity | Definition | Impact |
|----------|-----------|--------|
| **Critical** | Correctness bugs, security vulnerabilities, data loss, Safety-Immutable Rule violations. Must include reproduction scenario. | Blocks current cycle. Must be fixed before merge. |
| **Important** | Logic gaps, missing edge cases, performance issues. | Should fix. Can defer with documented rationale. |
| **Suggestion** | Style, naming, minor improvements. | Non-blocking. Implemented at discretion. |

**Key Rules**:

- Only HIGH CONFIDENCE findings — exact `file:line` + reproduction scenario + proposed fix.
- Severity is not negotiable: on disagreement, default to the HIGHER classification. The reviewer who raised the finding has final say on their own findings.
- MUST check against `FACTORY_TRAPS.md` for known patterns.
- MUST flag any removal of error handling, validation, catch blocks, or defensive checks as **Critical**.
- Findings that cannot be reproduced with a concrete scenario are dismissed as phantom findings.

**Output**:

```
Status: SUCCESS | PARTIAL | BLOCKED
Frozen SHA: {sha}
Findings: [
  {
    id: "RQ-N",
    severity: "Critical|Important|Suggestion",
    category: "security|correctness|ux|performance",
    file: "src/path/to/file.js",
    line: N,
    description: "...",
    reproduction: "...",
    fix: "..."
  }
]
Traps Violated: [TRAP-N, ...] (or "none")
```

---

### 4.7 Factory Optimization Expert Team

**Mandate**: Optimize the FACTORY, not the product. Watch how teams perform, identify waste, improve briefs, tune rules, and ensure the process itself converges toward efficiency.

**Reports to**: Orchestrator

**Team Manager**: Meta-Analyst — synthesizes pattern analysis, velocity data, and brief quality assessment into actionable process improvements.

**Expert Agents**:

| Agent | Viewpoint |
|-------|-----------|
| **Pattern Analyst** | Analyzes recurring findings. When a finding category hits 3+ occurrences, creates a prevention script in `docs/factory/checks/`. Manages false positive rates — removes rules with >20% false positive rate across 3+ cycles. Updates `FACTORY_TRAPS.md` with patterns at 2+ occurrences. |
| **Velocity Engineer** | Identifies bottlenecks. Tracks: cycle time, build pass rate, items completed per cycle, waste ratio (BLOCKED/FAILED items vs completed), queue throughput. Recommends scheduling parameter adjustments. |
| **Brief Optimizer** | Evaluates brief quality by analyzing team output. Are reports well-structured? Do builds match acceptance criteria? Are experts finding real issues or generating noise? Recommends brief template improvements. Evaluates team composition effectiveness — right number of experts, right viewpoints? |

**Composition**: 3 experts + 1 manager. Runs every 5th cycle.

**Timeout**: 10 minutes

**Required Reads**: `FINDING_HISTORY.md`, `FACTORY_METRICS.md`, last 10 cycle files from `docs/factory/state/cycles/`

**Responsibilities**:

1. **Generate prevention rules** — finding categories with 3+ occurrences become automated checks in `docs/factory/checks/check-{name}.js`. New rules MUST be validated against current code before activation. Reject any rule with >20% false positive rate.
2. **Remove ineffective rules** — rules with >20% false positive rate across 3+ cycles are removed. Rule removed and regenerated >1x in 10 cycles is permanently blocked.
3. **Update FACTORY_TRAPS.md** — patterns with 2+ occurrences are documented as traps. Include: pattern description, trigger condition, correct approach, files affected.
4. **Track factory metrics** — compile per-cycle data into trend analysis. Flag: declining build pass rate, increasing cycle time, growing BLOCKED count.
5. **Simplify factory artifacts** — every 10th cycle, review factory state files for bloat. Trim, consolidate, archive old data.

**Write Permissions**:

| File/Directory | Permission |
|---------------|-----------|
| `FACTORY_TRAPS.md` | READ + WRITE |
| `docs/factory/checks/` | READ + WRITE (new check scripts) |
| `CLAUDE.md` | **NEVER** |
| `AGENTS.md` | **NEVER** |
| Project files outside `factory/` | **NEVER** |

**Security Constraint**: May NEVER delete Security-Immutable prevention rules. SI rules are permanent regardless of false positive rate.

**Output**:

```
Status: SUCCESS | PARTIAL
Summary: {one line}
Rules Generated: [{name, trigger_count, validated: true|false}]
Rules Removed: [{name, reason, false_positive_rate}]
Patterns Added: [{id, description, occurrences}]
Velocity Findings: [{metric, trend, recommendation}]
Brief Improvements: [{team, change, rationale}]
Factory Metrics: {
  avg_cycle_time: "Nm",
  build_pass_rate: "N%",
  items_per_cycle: N,
  waste_ratio: "N%",
  queue_depth: N,
  prevention_rule_count: N,
  false_positive_rate: "N%"
}
```

---

## 5. Team Interaction Model, Conflict Resolution & Governance

### 5.1 Team Interaction Model

```
                        ┌──────────────────┐
                        │   ORCHESTRATOR    │
                        └──┬─┬─┬─┬─┬─┬─┬──┘
                           │ │ │ │ │ │ │
          ┌────────────────┘ │ │ │ │ │ └────────────────┐
          │    ┌─────────────┘ │ │ │ └─────────────┐    │
          │    │    ┌──────────┘ │ └──────────┐     │    │
          │    │    │            │            │     │    │
          ▼    ▼    ▼            ▼            ▼     ▼    ▼
        ┌───┐┌───┐┌───┐   ┌─────────┐   ┌───┐┌───┐┌───────┐
        │CPO││Res││Ovs│   │ COMMON  │   │Bld││ QA││Review │
        └───┘└───┘└───┘   │PIPELINE │   └───┘└───┘└───────┘
          │    │    │      │         │     ▲    │    │
          │    │    │      │  WORK_  │     │    │    │
          │    │    └─────►│  QUEUE  │─────┘    │    │
          │    └──────────►│         │          │    │
          └───────────────►│ REVIEW_ │◄─────────┘    │
                           │  QUEUE  │◄──────────────┘
                           └─────────┘
                               ▲
        ┌──────────────────────┘
        │
    ┌───────┐
    │FactOpt│
    └───────┘
```

**Information flow** (numbered by phase within a cycle):

1. **Orchestrator → CPO**: Brief with metrics, queue state, north star. CPO returns vision assessment, memos, team recommendations.
2. **Orchestrator → Research/Discovery**: Brief with project docs, north star, attempt history. Discovery returns work items for the pipeline.
3. **Orchestrator → Oversight**: Brief with metrics and queue state. Oversight returns monitoring findings, CPO memo proposals.
4. **Oversight → Common Pipeline**: Oversight findings become work items or review items in the queues (written by Orchestrator based on Oversight report).
5. **Common Pipeline → Build**: Orchestrator pulls top item, briefs Build team. Build returns committed branch or BLOCKED status.
6. **Build output → QA**: Orchestrator briefs QA with build results. QA returns PASS/FAIL verdict with gate details.
7. **Build output → Review**: Orchestrator briefs Review with frozen SHA diff. Review returns adversarial findings for the pipeline.
8. **Orchestrator → Factory Optimization**: Brief with metrics, cycle history, finding patterns. FactOpt returns rule changes and process recommendations.

### 5.2 Conflict Resolution

| Conflict | Resolution |
|----------|-----------|
| **CPO vs Oversight** | CPO can defer features and reprioritize work items. CPO CANNOT defer Critical-severity findings — these bypass priority and enter the queue at the top. |
| **Build BLOCKED** | Build team MUST revert working tree (`git checkout .`), return to `{working_branch}`, delete the work branch, and confirm a clean tree. The item returns to the queue with BLOCKED status and failure notes. |
| **QA FAIL** | Build is reverted. The work branch is deleted. Failure items re-enter the Common Pipeline as high-priority review items. No negotiation — QA has veto power. |
| **Review severity disagreement** | Default to the HIGHER classification. The reviewer who raised the finding has final say on their own findings' severity. |
| **Termination carve-out** | Critical security or reliability findings block termination regardless of how many panel experts vote STOP. A single Critical finding from any expert is sufficient to resume the loop. |
| **Duplicate findings** | Keep the finding with HIGHER severity. Note both sources in the finding record. Do not create two queue entries for the same issue. |
| **CPO vs Factory Optimization** | CPO sets product direction. Factory Optimization sets process direction. Neither overrides the other's domain. If a process change affects product quality, CPO can veto. If a product change affects process efficiency, FactOpt can flag but not veto. |
| **Multiple teams flag same file** | The first team to claim the file in a cycle owns it. Other teams must specify their requirements as inputs to the file owner's brief. |

### 5.3 Security-Immutable Rules

These rules can NEVER be weakened, bypassed, or removed by any team, any process, or any optimization. Violation is automatically **Critical** severity and blocks the current cycle.

| Rule | Description | Enforcement |
|------|------------|-------------|
| **SI-1** | Auth middleware (`src/utils/auth.js` token validation, `src/server.js` middleware chain) must not be bypassed, weakened, or made optional. | Review team checks every cycle. Prevention check scans for auth middleware removal. |
| **SI-2** | Rate limiting must not be removed or weakened. The threshold is adjustable; the mechanism is permanent. | Review team checks every cycle. Prevention check scans for rate limiter removal. |
| **SI-3** | Path traversal prevention in the file browser must remain functional. All file paths must be validated against the base directory. | Security Reviewer explicitly checks every cycle. Prevention check verifies path validation code exists. |
| **SI-4** | Session isolation in `src/utils/session-store.js` — no cross-session data access. One session's data must never leak to another session. | Security Reviewer explicitly checks every cycle. |
| **SI-5** | Port safety — never touch port 7777 or any port below 11000. All test ports must be >11000. | `check-port-safety.js` prevention check. `cleanup-resources.js` sweep. Every Build brief includes the constraint. |
| **SI-6** | No secrets in code, commits, or logs. No API keys, tokens, passwords, or credentials hardcoded anywhere. | `check-no-attribution.js` checks for common patterns. Review team Security Reviewer scans diffs. |

**Enforcement mechanism**: Every Build Manager brief includes the full SI rule list. The quality gate includes prevention checks that scan for violations. The Review team's Security Reviewer explicitly verifies SI compliance on every review cycle. A single SI violation blocks the entire cycle — no workarounds, no deferrals.

### 5.4 Systemic Block Escalation

Any team may issue a `SYSTEMIC_BLOCK` when it detects a process-level failure that prevents forward progress. This is distinct from a work item being BLOCKED — a systemic block affects the factory itself.

**Format**:

```json
{
  "type": "SYSTEMIC_BLOCK",
  "condition": "Description of the systemic failure",
  "cycles_affected": [N, N+1, ...],
  "evidence": "Concrete data: metrics, cycle files, finding IDs",
  "required_fix": "What must change in the factory process"
}
```

**When a SYSTEMIC_BLOCK is received**:

1. The next Build cycle is **SUSPENDED**. No new items are pulled from the pipeline.
2. The Orchestrator processes the block before any other dispatch.
3. If the block requires a protocol amendment, the Orchestrator implements it and logs the change.
4. The block is logged to the cycle file with full context.
5. Once resolved, normal operation resumes.

**Critical properties**:

- A systemic block CANNOT be deferred as a work item. It supersedes normal priority.
- A systemic block CANNOT be killed by CPO. It must be resolved.
- If the same systemic block recurs after being "resolved," the factory halts and requires human intervention.
- The Lifecycle Auditor (CPO team) MUST raise a systemic block when the same gap appears in 2+ consecutive cycles.

### 5.5 Adapting Team Composition

The factory's team structure is not fixed. The CPO Expert Team can recommend changes:

| Change Type | Example | Process |
|-------------|---------|---------|
| **Create** | Add a Documentation Expert Team | CPO recommends → Orchestrator evaluates feasibility → implemented next cycle |
| **Modify** | Add a Mobile UX expert to Oversight | CPO recommends → Orchestrator evaluates → expert added next cycle |
| **Reduce** | Remove Competitor Researcher from Discovery (no competitors found) | CPO recommends → Orchestrator confirms no regression → expert removed next cycle |
| **Dissolve** | Remove Factory Optimization (process has converged) | CPO recommends → Orchestrator verifies 5+ cycles of stable metrics → team dissolved next cycle |

**Rules**:

- Changes NEVER happen mid-cycle. Always take effect at the start of the next cycle.
- All changes are logged to the cycle file with rationale.
- Factory Optimization tracks the effects of composition changes on velocity and quality.
- Core teams (Build, QA, Review) cannot be dissolved — only modified.
- The Orchestrator can reject a recommendation with documented rationale.

### 5.6 Orchestrator Context Budget

The Orchestrator operates under a strict context budget. It reads state files, not code. The total read volume per cycle must stay within ~10K tokens.

| State File | Typical Size | Purpose |
|-----------|-------------|---------|
| `FACTORY_STATE.json` | ~200 tokens | Cycle number, cost, convergence counters, phase |
| `WORK_QUEUE.md` | ~500-1500 tokens | Work items: ID, title, priority, status |
| `REVIEW_QUEUE.md` | ~500-1000 tokens | Review findings: ID, severity, category, status |
| `VERIFY_STATUS.md` | ~200 tokens | Last quality gate results |
| `FACTORY_METRICS.md` | ~1000-2000 tokens | Per-cycle metrics table (last 15 rows) |
| Last cycle file | ~500-1000 tokens | What happened in the previous cycle |
| `SYSTEMIC_BLOCKS.md` | ~200-500 tokens | Active systemic blocks (if any) |
| `CPO_DIRECTIVES.md` | ~200-500 tokens | Active CPO memos and directives |
| **Total** | **~4000-8000 tokens** | **Well within 10K budget** |

**Rules**:

- The Orchestrator NEVER reads source code. It dispatches teams that read source code.
- Any state file exceeding 3K tokens must be truncated. Keep the most recent entries. Archive the rest.
- `FACTORY_METRICS.md` retains only the last 15 rows. Older rows are archived to `docs/factory/state/archive/`.
- Queue files show only ID, title, priority, and status — not full item details. Full details live in `docs/factory/state/queue-details/`.
- If total state exceeds 10K tokens, the Orchestrator must trim before proceeding. This is a hard limit, not a guideline.
---

## 6. Orchestrator: Setup, Duties & Cron

The orchestrator is the factory's control plane. It reads state, makes decisions, dispatches teams, collects results, and writes state. It never reads source code, never implements changes, never reviews code, and never runs tests. Its entire world is state files and team reports.

### Initial Setup (fresh orchestrator session)

When the orchestrator starts — whether first launch or crash recovery — it executes these steps in order:

1. **Read `.claude/session-state.md`** — recover cycle number, active work, last decisions. If the file does not exist, this is a fresh start: proceed to Bootstrap (Cycle 0).
2. **Read `docs/factory/state/WORK_QUEUE.md`** and **`docs/factory/state/REVIEW_QUEUE.md`** — understand current pipeline contents.
3. **Read this file (`FACTORY_PROTOCOL.md`)** — re-anchor on the decision table, team definitions, rules, and constraints. After auto-compaction this is critical: the orchestrator must re-internalize the protocol.
4. **Read `CLAUDE.md`** — project contract, coding style, constraints, architecture.
5. **Check `git log --oneline -5`** — verify state files match reality. If the last commit does not match what session-state claims, investigate before proceeding.
6. **Check `git status`** — if the working tree is dirty, stash immediately: `git stash push -m 'factory-recovery-cycle-N'`. Log the stash in session-state.md.
7. **Determine current cycle** — read `currentCycle` from `FACTORY_STATE.json`. If the file exists, next cycle is `currentCycle + 1`. If performing bootstrap, cycle is 0.
8. **Set up dual cron** — create the heartbeat cron and, if resuming mid-dispatch, the one-shot completion cron. See below.
9. **Enter main loop** — proceed to Section 8.

### Cron Setup — Dual Cron System

The factory uses two complementary crons. Together they guarantee the factory never stalls and cycles transition as fast as possible.

#### Cron 1: Heartbeat (fixed, every 12 minutes)

```
CronCreate({
  cron: "*/12 * * * *",
  prompt: "FACTORY HEARTBEAT — Check team status, collect completed reports, dispatch if idle. Read docs/factory/state/FACTORY_STATE.json first.",
  recurring: true
})
```

- Fires every 12 minutes for the life of the session
- Checks: are dispatched teams still running? Have any returned reports?
- If teams have completed: collects reports, processes them, dispatches next eligible teams
- If teams are still running: no-op, exits immediately
- Safety net: even if the one-shot cron misfires or the cycle takes longer than estimated, the heartbeat catches it within 12 minutes

#### Cron 2: Cycle Completion (dynamic, one-shot)

```
CronCreate({
  cron: "<estimated completion minute> <hour> <day> <month> *",
  prompt: "FACTORY CYCLE COMPLETE — Collect all team reports, process results, advance cycle. Read docs/factory/state/FACTORY_STATE.json first.",
  recurring: false
})
```

- Created after each DISPATCH step
- Timed to fire when the dispatched teams are expected to finish
- Enables fast cycle transitions — no waiting for the next 12-minute heartbeat
- Auto-deletes after firing (one-shot behavior)

#### Timing Estimates

| Work Scope | Build Timeout | QA Timeout | Buffer | Total Estimate |
|-----------|--------------|-----------|--------|----------------|
| Small fix (1-2 files) | 10 min | 5 min | 2 min | 17 min |
| Medium feature (3-7 files) | 15 min | 10 min | 2 min | 27 min |
| Large feature (8+ files) | 15 min | 10 min | 5 min | 30 min |

#### How They Work Together

Timeline example for a medium feature (27 min estimated):

```
T+0:00  Cycle N starts. Dispatch Build + Review + Oversight.
        Create one-shot for T+27.
T+7:00  Review Team finishes early. Heartbeat not due yet.
T+12:00 HEARTBEAT fires. Collects Review report. Build still running.
        No new dispatch (Build in progress).
T+18:00 Build Team finishes. QA Team eligible.
        (Heartbeat not due for 6 more minutes.)
T+24:00 HEARTBEAT fires. Collects Build report. Dispatches QA.
        Creates NEW one-shot for T+24+10 = T+34.
T+27:00 Original one-shot fires. QA still running. No-op.
        (One-shot auto-deletes.)
T+31:00 QA finishes.
T+34:00 New one-shot fires. Collects QA report. Processes all.
        Writes state. Advances cycle. Dispatches Cycle N+1.
```

The heartbeat catches early completions. The one-shot catches expected completions. Between them, no team sits idle for more than 12 minutes.

#### Setup Procedure

1. Create the heartbeat at session start. It persists for the session (session-only, auto-expires after 7 days).
2. After each DISPATCH, create a one-shot timed to the estimated completion.
3. The one-shot auto-deletes after firing. Create a new one after each dispatch.
4. The heartbeat continues independently. Both are session-only crons — they die when Claude exits.

### Ongoing Duties (every cycle)

The orchestrator executes these 12 steps in order. Every cycle. No deviation.

1. **READ state files** — FACTORY_STATE.json, WORK_QUEUE.md, REVIEW_QUEUE.md, VERIFY_STATUS.md, FACTORY_METRICS.md, SYSTEMIC_BLOCKS.md, last cycle file. Target: ~10K tokens total.
2. **DECIDE which teams to dispatch** — apply the decision table (Section 8). Evaluate every condition top to bottom. All TRUE conditions generate eligible dispatch. Cap at 7 teams.
3. **FREEZE HEAD SHA for Review Team** — `git rev-parse HEAD` before any dispatch. Review operates on this frozen SHA. Record it in cycle state.
4. **DISPATCH all eligible teams in parallel** — spawn as Agent tool calls with self-contained briefs. Include project contract, relevant state, specific task, output format. Sequential dependencies (Build → QA) handled within the dispatch plan.
5. **COLLECT structured reports** — each team returns: Status, Summary, Items Completed, Items Added, Files Changed, Tests Before/After, Commits, Blockers.
6. **PROCESS reports** — write findings to pipeline queues, update statuses, record metrics. See Section 8 PROCESS step for details.
7. **GATE: if QA FAILs, ensure build reverted** — verify the work branch was deleted or the commit was reverted. Confirm clean tree with `git status`. The item returns to the pipeline as high-priority NEW.
8. **WRITE state files** — update queue indexes, metrics, cycle file, session-state.md, FACTORY_STATE.json. Orchestrator is sole writer (R1).
9. **COMMIT state file changes** — `git add docs/factory/state/ && git commit -m "factory: cycle {N} state update"`. Only state files, never source code.
10. **SHUTDOWN completed teams** — send `shutdown_request` to all teams that returned reports.
11. **CLEANUP teams** — `TeamDelete` for each shutdown team. Release resources.
12. **ADVANCE cycle number** — increment `currentCycle` in FACTORY_STATE.json. Evaluate termination criteria.

### What the Orchestrator Must NEVER Do

- **Read source code** — the orchestrator's world is state files and reports. It never opens `src/`, `e2e/`, or any application code.
- **Implement code changes** — that is the Build Team's job. The orchestrator never writes to any file outside `docs/factory/state/` and `.claude/session-state.md`.
- **Make architectural decisions** — the orchestrator dispatches teams who make technical decisions. It evaluates their reports, not their code.
- **Review code** — adversarial review is the Review Team's job. The orchestrator processes review findings, it does not generate them.
- **Run tests** — the QA Team and Build Team run tests. The orchestrator reads their pass/fail reports.
- **Communicate directly with individual team members** — the orchestrator communicates with team leads only. Never with individual agents inside a team.
- **Write prose in state files** — state files contain structured data (tables, JSON, status markers). No paragraphs, no explanations, no narrative.
- **Exceed 10K tokens per cycle** — if state file reads approach this limit, something is wrong. Truncate, archive, or alert.

### Context Protection

The orchestrator must guard its context window aggressively:

- **Truncate reports** to structured fields only. Discard verbose logs, stack traces, and commentary. Extract: Status, Summary, Items Completed, Items Added, Files Changed, Tests Before/After, Commits, Blockers.
- **Never quote team messages** in state files. Summarize findings as one-line entries with severity and file reference.
- **Use session-state.md as external memory** — write decisions, active work, and cycle state to disk. Re-read on recovery. The orchestrator's conversation history is ephemeral; session-state.md is persistent.
- **After auto-compaction**: re-read `session-state.md`, re-read this protocol file, re-create both crons (heartbeat + any pending one-shot), and resume from where the session-state indicates.

---

## 7. Bootstrap: Cycle 0

Before the factory runs its first real cycle, it must understand the project and initialize state. There are two scenarios.

### Scenario A: Existing Project (state files exist)

If `docs/factory/state/FACTORY_STATE.json` exists and contains valid state:

1. **Skip Recon** — the project is already understood.
2. **Read existing state files** — FACTORY_STATE.json, WORK_QUEUE.md, REVIEW_QUEUE.md, VERIFY_STATUS.md, FACTORY_METRICS.md.
3. **`git log --oneline -10`** and **`git status`** — verify state matches reality.
4. **If dirty**: `git stash push -m 'factory-recovery-cycle-N'`.
5. **Resume from next cycle** — set cycle to `currentCycle + 1` from FACTORY_STATE.json and enter the main loop.

### Scenario B: New/Fresh Start

#### Step 1: Reconnaissance

Spawn a single **Recon Agent** (Explore subagent, read-only) to answer these 10 questions:

1. **Current test count** — run `npm test` and capture the pass/fail/total counts
2. **Current state of codebase** — what works, what was built recently, what is the maturity level
3. **Open issues, TODOs, spec gaps** — grep for TODO, FIXME, HACK; compare specs to implementation
4. **Known traps from `docs/history/`** — what has been debugged before, what patterns cause problems
5. **Documentation coverage** — which specs exist, which are stale, what is missing
6. **Build/test/lint commands** — confirm `npm test`, E2E command, audit command, prevention checks
7. **Project structure** — directory layout, key files, entry points, approximate sizes
8. **CI pipeline** — what runs in CI, what is the workflow, what are the constraints
9. **Current state** — does the app start, do tests pass, are there known broken areas
10. **Where the project wants to go** — north star, roadmap hints, open specs, issue tracker themes

The Recon Agent reads:
- `CLAUDE.md`
- `package.json`
- `README.md`
- `docs/specs/` (all files)
- `docs/adrs/` (all files)
- `docs/history/` (all files)
- `git log --oneline -20`

The Recon Agent does NOT modify anything. It returns a structured report with answers to all 10 questions.

#### Step 2: Project Contract

The project contract is already defined in `FACTORY_PROTOCOL.md` Section 2. No separate `FACTORY.md` is needed.

Write `docs/factory/state/FACTORY_STATE.json`:

```json
{
  "project": "ai-or-die",
  "testCountBaseline": 420,
  "startedAt": "2026-04-01T00:00:00Z",
  "currentCycle": 0,
  "phase": "running",
  "workingBranch": "main",
  "cumulativeCost": 0,
  "consecutiveIdleCycles": 0,
  "lastReviewedSHA": null,
  "cycleCapRemaining": 30,
  "costCeiling": 50.00
}
```

The `testCountBaseline` comes from the Recon Agent's `npm test` output. The `workingBranch` is captured from `git branch --show-current` at factory init — this is the branch the factory merges completed work into. All references to `{working_branch}` throughout this protocol resolve to this value. All other fields are initialized to their starting values.

#### Step 3: State File Initialization

Create the `docs/factory/state/` directory structure:

```
docs/factory/state/
├── FACTORY_STATE.json          # Cycle counter, cost, phase, convergence
├── WORK_QUEUE.md               # What needs building (index)
├── REVIEW_QUEUE.md             # What needs fixing (index)
├── VERIFY_STATUS.md            # Last gate results
├── FACTORY_METRICS.md          # Per-cycle metrics table
├── FINDING_HISTORY.md          # Finding categories and counts
├── FACTORY_TRAPS.md            # Known patterns and prevention rules
├── SELF_OPT_LOG.md             # Self-optimization decisions
├── SYSTEMIC_BLOCKS.md          # Active systemic blockers
├── CPO_DIRECTIVES.md           # CPO team directives and priorities
├── queue-details/              # One file per work/review item
│   ├── WI-1.md                 # Work Item detail
│   └── RQ-1.md                 # Review Queue item detail
├── cycles/                     # One JSON file per cycle
│   └── cycle-000.json          # Cycle 0 record
├── checks/                     # NOTE: prevention checks live at
│                               #   docs/factory/checks/ (not here)
└── .factory-lock               # Concurrency guard
```

**Important**: Prevention check scripts live at `docs/factory/checks/` — the existing location with `run-checks.js` and all `check-*.js` files. The `state/` directory is purely for runtime state. Do not duplicate check scripts into state.

Initialize each file with its empty/header state:

- **WORK_QUEUE.md**: table header (`| ID | Priority | Status | Summary | Cycle Added |`)
- **REVIEW_QUEUE.md**: table header (`| ID | Severity | Status | Summary | Cycle Added |`)
- **VERIFY_STATUS.md**: `Last verified: N/A`
- **FACTORY_METRICS.md**: table header (`| Cycle | Teams | Items Done | Items Added | Tests | Build | E2E | Cost |`)
- **FINDING_HISTORY.md**: `No findings yet.`
- **FACTORY_TRAPS.md**: populated from any existing trap knowledge, or empty template
- **SELF_OPT_LOG.md**: `No optimizations yet.`
- **SYSTEMIC_BLOCKS.md**: `No active blocks.`
- **CPO_DIRECTIVES.md**: `Awaiting first CPO cycle.`

#### Step 4: First Dispatch

Cycle 0 dispatches two groups in parallel:

1. **CPO Team + Research/Discovery Team** — research what to build. The CPO Team sets product direction based on the north star. The Research/Discovery Team surveys the codebase for gaps, missing features, quality issues, and spec mismatches. Together they populate the initial work queue.

2. **Review Team** — baseline quality scan. Reviews the current state of `{working_branch}` branch (or `main` if {working_branch} does not exist yet). Identifies existing quality issues, security concerns, cross-platform gaps, and dead code. Populates the initial review queue.

After both groups complete, the orchestrator:
- Processes their reports
- Writes initial items to WORK_QUEUE.md and REVIEW_QUEUE.md
- Creates queue-detail files for each item
- Writes the cycle-000.json record
- Advances to Cycle 1 and enters the main loop

---

## 8. The Main Loop

Every cycle follows this exact flow. The orchestrator never deviates.

### 1. READ (~30 seconds)

Read state files only — small, structured, <10K tokens total:

- **`FACTORY_STATE.json`** — current cycle, cost, convergence counters, phase
- **`WORK_QUEUE.md`** — what needs building (index with status markers)
- **`REVIEW_QUEUE.md`** — what needs fixing (index with status markers)
- **`VERIFY_STATUS.md`** — did the last build pass verification
- **`FACTORY_METRICS.md`** — trends across cycles
- **`SYSTEMIC_BLOCKS.md`** — any active systemic blockers that halt dispatch
- **Last cycle file** from `docs/factory/state/cycles/` — what happened in the previous cycle

The orchestrator does NOT read queue-detail files (those are for teams). It reads only the index tables.

### 2. DECIDE (~30 seconds)

Apply the decision table. Evaluate EVERY condition from top to bottom. All conditions that evaluate to TRUE generate an eligible dispatch. Priority determines which teams are dropped if the cap is exceeded.

| # | Condition | Team to Dispatch | Priority |
|---|-----------|-----------------|----------|
| 0 | `SYSTEMIC_BLOCKS.md` has an active block | **HALT** — resolve the block before any dispatch. No teams are spawned. | 0 (highest) |
| 1 | `git rev-parse HEAD` != `lastReviewedSHA` in FACTORY_STATE.json | **Review Team** (frozen SHA) | 1 |
| 2 | Always TRUE (every cycle) | **Oversight Team** (lightweight product scan) | 2 |
| 3 | WORK_QUEUE.md or REVIEW_QUEUE.md has items with status `NEW` | **Build Team** | 3 |
| 4 | Build Team ran this cycle AND committed code to its work branch (`factory/wip-{item-id}`) | **QA Team** (verification gate — checks out the work branch) | 4 |
| 5 | QA ran this cycle AND returned PASS | **Simulate** (E2E subset via shell) | 5 |
| 6 | `(cycle % 3 == 0)` OR `(queue items with NEW + IN_PROGRESS < 3)` OR `(both queues have zero NEW)`. **Skip if** `(NEW + IN_PROGRESS) > 15` (queue cap — focus on execution, not discovery). | **Research/Discovery Team** + **CPO Team** | 6 |
| 7 | `cycle % 5 == 0` | **Factory Optimization Team** + **Oversight deep audit** | 7 |

**Cap: maximum 7 teams per cycle.** If more than 7 are eligible, drop the lowest-priority teams (highest priority number).

**Sequential dependencies within a cycle**: Conditions 4 and 5 are sequential gates. QA (condition 4) only runs after Build completes and commits code. Simulate (condition 5) only runs after QA passes. These are not dispatched upfront — they are triggered by the results of earlier teams within the same cycle.

**Parallel dispatch**: Conditions 1, 2, 6, and 7 are independent of the Build→QA→Simulate chain and dispatch in parallel with it.

```
                    ┌─ Review Team (frozen SHA) ──────┐
                    ├─ Oversight Team (product scan) ──┤
                    │                                   │
Cycle start ───────►├─ Discovery (if eligible) ────────┤──► all write to Pipeline
                    ├─ CPO (if eligible) ──────────────┤    (for NEXT cycle's Build)
                    ├─ Factory-Opt (if eligible) ──────┤
                    │                                   │
                    └─ Build Team ──► QA Team ──────────┘──► cycle complete
                       (parallel       (sequential
                        with above)     after Build)
```

### 3. DISPATCH (~1 minute)

Spawn ALL eligible teams as agents in a single dispatch. Each team receives a self-contained brief that includes:

- **Project contract** — from Section 2 of FACTORY_PROTOCOL.md
- **Relevant state** — queue items for Build, frozen SHA for Review, metrics for Factory-Opt
- **Specific task** — what this team must do this cycle
- **Output format** — the exact structured report format expected
- **Constraints** — port safety, attribution rules, file ownership boundaries

Teams that depend on prior results (QA depends on Build) are dispatched after those results arrive, within the same cycle.

### 4. COLLECT

Wait for team reports. Each team returns a structured report:

```
Status: SUCCESS | PARTIAL | FAILED | BLOCKED
Summary: One-line description of what happened
Items Completed: [list of item IDs marked done]
Items Added: [new items with priority and severity]
Files Changed: N (count)
Tests Before: N
Tests After: N
Commits: [list of {sha, message}]
Blockers: [anything preventing forward progress]
```

The orchestrator truncates any report exceeding 500 tokens. Verbose output, stack traces, and commentary are discarded. Only structured fields are retained.

### 5. PROCESS (~1 minute)

Map each team's report to state file updates:

- **Build SUCCESS**: mark item as DONE in the queue index. Record commit SHA. Update test count.
- **Build BLOCKED/FAILED**: verify clean tree (`git status`). Mark item as BLOCKED with reason. If work branch exists, delete it.
- **QA PASS**: record result in VERIFY_STATUS.md. Proceed to Simulate if eligible.
- **QA FAIL**: revert the build commit (delete work branch: `git branch -D factory/wip-{item-id}`). Write each failure back to the pipeline as a high-priority NEW item in REVIEW_QUEUE.md. The original item returns to WORK_QUEUE as NEW with failure notes appended.
- **Review findings**: create `queue-details/RQ-{N}.md` for each finding. Add entries to REVIEW_QUEUE.md index as NEW.
- **Oversight findings**: route to WORK_QUEUE.md or REVIEW_QUEUE.md depending on nature (feature gap → WORK_QUEUE, quality issue → REVIEW_QUEUE).
- **CPO memos**: add directives to CPO_DIRECTIVES.md. Create work items in WORK_QUEUE.md for actionable items. Process team recommendations for priority adjustments.
- **Factory Optimization**: apply process parameter adjustments. Update FACTORY_TRAPS.md with new patterns. Log changes to SELF_OPT_LOG.md.

### 6. GATE

If QA ran this cycle:

**On FAIL:**
1. Verify the work branch was deleted or reverted.
2. Confirm clean tree: `git status` shows no uncommitted changes.
3. Item returns to pipeline as high-priority NEW.

**On PASS — the orchestrator MUST verify these conditions:**

1. **E2E spec files exist**: `find e2e/tests/ -name '*.spec.js' | wc -l` returns a count.
2. **IF spec count > 0**: the QA report confirms E2E ran (`e2e_tests.ran: true`) AND the E2E test count is > 0.
3. **IF spec count > 0**: both mobile and desktop viewport projects that were in the rotation PASS.

If ANY of these conditions fails, reclassify the result as QA FAIL:

```
Gate override: QA PASS invalidated.
Reason: "E2E gate omitted — spec files exist but E2E was not executed."
Action: Treat as QA FAIL. Revert build. Re-queue item.
```

This gate is non-bypassable (Rule R13). No team may weaken it. No process improvement may remove it.

### 7. WRITE (~30 seconds)

Update all state files. The orchestrator is the SOLE writer (R1):

- **WORK_QUEUE.md** — add new items, update statuses (NEW → IN_PROGRESS → DONE | BLOCKED)
- **REVIEW_QUEUE.md** — add new findings, update statuses
- **VERIFY_STATUS.md** — record gate results (PASS/FAIL, test counts, E2E results)
- **FINDING_HISTORY.md** — increment category counts for new findings
- **FACTORY_METRICS.md** — append row for this cycle
- **Cycle file** — write `docs/factory/state/cycles/cycle-{NNN}.json` with complete cycle record
- **FACTORY_STATE.json** — update currentCycle, cumulativeCost, consecutiveIdleCycles, lastReviewedSHA
- **`.claude/session-state.md`** — update active work, completed items, decisions, next steps

### 8. COMMIT

Commit state file changes only:

```bash
git add docs/factory/state/
git commit -m "factory: cycle {N} state update"
```

Only state files. Never source code. Source code commits are made by the Build Team on work branches.

### 9. SHUTDOWN

Send `shutdown_request` to every team that returned a report this cycle:

```json
{"type": "shutdown_request", "reason": "Cycle {N} complete. Thank you."}
```

Wait for acknowledgment. Approving shutdown terminates the team's process.

### 10. CLEANUP

Call `TeamDelete` for each team that was shut down. This removes team config files and task list directories, freeing resources.

### 11. ADVANCE

Increment `currentCycle` in FACTORY_STATE.json. Update `cycleCapRemaining`.

### 12. EVALUATE TERMINATION

Check stopping criteria:

- `cycleCapRemaining <= 0` → auto-terminate
- `cumulativeCost >= costCeiling` → auto-terminate
- `consecutiveIdleCycles >= 5` → auto-terminate
- All items BLOCKED for 2+ consecutive cycles → auto-terminate
- Convergence criteria met (Section 15 of FACTORY_PROTOCOL.md) → enter Termination Gate

If none of the above: the heartbeat cron or one-shot completion cron fires the next cycle. The loop continues.

---

## 9. Pipeline Concepts

Each pipeline is a conceptual workflow executed by one or more expert teams. Pipelines do not run themselves — the orchestrator dispatches the right team at the right time based on the decision table.

### Pipeline-to-Team Mapping

| Pipeline | Executed By | Purpose |
|----------|-------------|---------|
| Discovery | Research/Discovery Team + CPO Team | Find what to build next |
| Continuous Review | Review Team | Find quality issues in recent changes |
| Build | Build Team | Implement the highest-priority item |
| Verification | QA Team | Independent quality gate |
| Self-Optimization | Factory Optimization Team | Convert patterns to prevention rules |
| Simulation | QA Team (E2E subset) | End-to-end validation |
| Process Improvement | Factory Optimization Team | Make the factory itself better |

### Discovery Pipeline

**Inputs**: Project docs (CLAUDE.md, specs, ADRs), north star definition, competitor landscape, deferred items from previous cycles, CPO directives.

**Process**:
1. Read project documentation and current state
2. Compare implemented features against the north star
3. Identify gaps: missing features, quality shortfalls, spec mismatches, stale docs
4. Prioritize each gap: P0 (blocks core workflow), P1 (significant improvement), P2 (polish)
5. Write 3-8 work items as `queue-details/WI-{N}.md` with full detail (acceptance criteria, scope, estimated cycles, risks)

**Output**: Queue-detail files for each discovered item. The orchestrator reads the team's structured report and adds entries to WORK_QUEUE.md.

**Dynamic frequency**: Runs when queue depth drops below 3 items (NEW + IN_PROGRESS), or every 3rd cycle, whichever comes first. Skipped when queue depth exceeds 10 (Discovery is not needed when there is plenty of work).

### Continuous Review Pipeline

**Inputs**: Frozen SHA, previous reviewed SHA, FACTORY_TRAPS.md patterns, project constraints from CLAUDE.md.

**Process**:
1. `git diff {prev_sha}..{frozen_sha}` — review only the diff, not full files
2. Scan for: security vulnerabilities, cross-platform issues, dead code, pattern violations, port safety violations, missing spec updates
3. Check each change against FACTORY_TRAPS.md known patterns
4. Rate findings: Critical (blocks), Important (should fix), Suggestion (non-blocking)
5. Only report HIGH CONFIDENCE findings — exact file:line, reproduction scenario, suggested fix

**Output**: Finding files as `queue-details/RQ-{N}.md`. The orchestrator processes the report and adds entries to REVIEW_QUEUE.md.

**Frequency**: Every cycle when `git rev-parse HEAD` differs from `lastReviewedSHA`. Skipped when no new commits exist since last review.

**Adversarial isolation**: The Review Team receives the diff and the traps list. It does NOT receive design rationale, the item description that motivated the change, or any justification for why the code was written that way. It finds problems.

### Build Pipeline

**Inputs**: Highest-priority item from WORK_QUEUE.md or REVIEW_QUEUE.md (review fixes take priority over new features), FACTORY_TRAPS.md, project constraints.

**Process**:
1. **Pre-flight**: `git status` — if dirty, stash. `git checkout -b factory/wip-{item-id}` from `{working_branch}`.
2. **Read item detail**: `queue-details/{item-id}.md` — acceptance criteria, scope, constraints.
3. **Read targeted source sections**: only the files and line ranges specified in the item scope. Never read entire large files.
4. **Read FACTORY_TRAPS.md**: check for patterns relevant to the files being modified.
5. **Implement**: make the changes. Write tests. Update specs if behavior changes.
6. **Run quality gate** (parallel where possible):
   - `npm test` — test count must not decrease from baseline
   - `npm audit --audit-level=high` — must pass
   - `node docs/factory/checks/run-checks.js --stage build` — prevention checks must pass
7. **If gate passes**: commit with Conventional Commits message referencing item ID. Report SUCCESS.
8. **If gate fails**: attempt to fix. Two attempts maximum. After 2 failures: delete work branch, report BLOCKED with failure details.

**Output**: Branch name, files changed, tests before/after, commit SHAs, pass/fail status.

**Scope rule (R7)**: One item per Build cycle. If an item is estimated at more than 2 cycles, the Build Team must split it into smaller items FIRST (report PARTIAL with the split items), then implement the first sub-item.

**Two fix attempts, then revert**: The Build Team does not iterate endlessly. Two attempts to pass the quality gate. If both fail, the work branch is deleted and the item returns to the queue as BLOCKED with a detailed failure reason. The next cycle can assign it to a fresh Build Team with the failure context.

### Verification Pipeline

**Inputs**: The work branch from Build, test baseline from FACTORY_STATE.json, E2E rotation schedule.

**Process**:
1. Run `npm test` — capture pass/fail/total. Compare against baseline.
2. Run `npm audit --audit-level=high` — must pass.
3. Run `node docs/factory/checks/run-checks.js --stage verify` — prevention checks on committed code.
4. Count E2E spec files: `find e2e/tests/ -name '*.spec.js'`
5. **If spec count > 0**: E2E is MANDATORY.
   - Start the application server on a port >11000
   - Run Playwright with the rotation schedule projects: `npx playwright test --config e2e/playwright.config.js --workers=2 --project=<rotation>`
   - Parse results: pass count, fail count, failure details
6. Report PASS (all gates clear) or FAIL (any gate fails, with specifics).

**Output**: Structured verification report with test counts, audit status, prevention check results, E2E results (if applicable).

**The E2E mandate**: When `.spec.js` files exist in `e2e/tests/`, E2E execution is mandatory. The QA Team cannot report PASS without running E2E. This is Rule R13 — non-bypassable.

### Self-Optimization Pipeline

**Inputs**: FINDING_HISTORY.md (finding categories with occurrence counts), FACTORY_METRICS.md (cycle-over-cycle trends), last 10 cycle files.

**Process**:
1. **Pattern Analyst**: identify finding categories with 3+ occurrences across cycles.
2. **Generate prevention scripts**: for each qualifying category, create `docs/factory/checks/check-{name}.js` that detects the pattern in staged code.
3. **Validate rules**: run each new rule against the current codebase. Reject any rule with >20% false positive rate.
4. **Update FACTORY_TRAPS.md**: add new patterns (2+ occurrences, even if not yet at the 3-occurrence threshold for a prevention script).
5. **Remove stale rules**: if an existing rule has >20% false positives across 3+ cycles, remove it.

**Output**: Rules generated (name, trigger count), rules removed (name, reason), patterns added to FACTORY_TRAPS.md.

**Constraint (R10)**: Self-Optimization NEVER modifies CLAUDE.md, AGENTS.md, README, or any docs/ content outside `docs/factory/`. It only writes to factory-specific files.

### Simulation Pipeline

**Inputs**: The work branch (post-Verification PASS), E2E rotation schedule (cycle mod 5).

**E2E Rotation Schedule** (5-cycle rotation):

| Cycle mod 5 | Projects | Purpose |
|-------------|----------|---------|
| 0 | golden-path, functional-core | Smoke test — core workflows |
| 1 | functional-extended, new-features | Extended features |
| 2 | mobile-iphone, mobile-pixel, integrations | Mobile + integrations |
| 3 | power-user-flows, ui-features | Power user + UI |
| 4 | **FULL SUITE** (all non-skipped projects) | Comprehensive check |

**Process**:
1. Determine which projects to run based on `cycle % 5`.
2. Run cleanup sweep: `node docs/factory/checks/cleanup-resources.js`
3. Start the application server on a port >11000.
4. Run: `npx playwright test --config e2e/playwright.config.js --workers=2 --project=<projects>`
5. Parse results. Report PASS or FAIL.

**After Verification passes** — Simulation is the final gate before merge. On PASS, the work branch merges to `{working_branch}`. On FAIL, the work branch is deleted and the item is re-queued.

### Process Improvement Pipeline

**Inputs**: FACTORY_METRICS.md (build pass rate, items per cycle, waste ratio, cycle duration), SELF_OPT_LOG.md, last 10 cycle files.

**Process**:
1. **Analyze factory metrics**: which cycles were fastest? Which had the most failures? What is the average items-per-cycle throughput?
2. **Identify bottlenecks**: are Build teams consistently timing out? Are Review teams generating too many low-severity findings? Are Discovery teams creating items that consistently get BLOCKED?
3. **Improve briefs**: refine the manager brief templates based on patterns in team failures.
4. **Improve decision table**: adjust scheduling parameters (Discovery frequency, queue cap thresholds) within pre-defined bounds.
5. **Improve report formats**: if teams consistently return information the orchestrator discards, simplify the required format.
6. **Simplicity pass** (every 10th cycle): review FACTORY_TRAPS.md, FACTORY_METRICS.md, and the decision table for unnecessary complexity. Remove what does not earn its keep.

**Output**: Proposals (human-reviewable), parameter adjustments (applied within bounds), brief improvements (written to SELF_OPT_LOG.md).

---

## 10. The Three Improvement Loops

The factory runs three concurrent improvement loops. Each operates on a different timescale and improves a different aspect of the system. Together they create a compounding effect.

### Loop 1: Product Loop (improves the software)

```
CPO Directives ──► Discovery ──► WORK_QUEUE ──► Build ──► QA ──► Review
       ▲                                                           │
       └───────────── findings fed back to Pipeline ◄──────────────┘
```

**Cadence**: Every cycle (Build + QA). Discovery + CPO every 3rd cycle or when queues run low.

**What it improves**: The ai-or-die application. Features, quality, cross-platform support, mobile responsiveness, voice input, file browsing — everything that moves toward the north star.

**Actors**: CPO Team sets direction. Research/Discovery Team finds gaps. Build Team implements. QA Team verifies. Review Team finds issues in what was built. Oversight Team checks alignment with product vision.

**Feedback path**: Review and QA findings feed back into the pipeline as high-priority items. The product improves monotonically.

### Loop 2: Quality Loop (finds and prevents problems)

```
Review ──► findings ──► REVIEW_QUEUE ──► Build (fix) ──► QA (verify fix)
  ▲                                                            │
  │          Oversight ──► findings ──────────┘                │
  │                                                            │
  └──────────── re-evaluate after fix ◄────────────────────────┘
```

**Cadence**: Every cycle (Review runs when diffs exist, Oversight runs every cycle).

**What it improves**: Code quality, security posture, cross-platform correctness, spec-code synchronization, pattern compliance.

**Actors**: Review Team finds issues adversarially. Oversight Team finds product-level quality gaps. Build Team fixes them. QA Team verifies the fixes hold.

**Feedback path**: Findings that recur (3+ occurrences) get promoted to prevention rules via the Process Loop. The codebase develops immune responses to its own failure patterns.

### Loop 3: Process Loop (improves the factory itself)

```
Factory Optimization ──► analyze metrics ──► improve briefs/rules
       ▲                                            │
       │                                            ▼
       └─── measure results ◄─── apply improvements
```

**Cadence**: Every 5th cycle.

**What it improves**: The factory's own efficiency. Brief quality, decision table accuracy, prevention rule precision, cycle duration, team dispatch patterns.

**Actors**: Factory Optimization Team analyzes metrics and proposes improvements. Applies parameter adjustments within bounds. Logs all changes.

**Feedback path**: Improved briefs lead to better team output. Better prevention rules catch problems earlier. Tighter scheduling reduces waste. The factory gets faster and more accurate over time.

### How the Loops Compound

The three loops create a virtuous cycle:

1. **Better prevention rules** (Process Loop) → **fewer bugs introduced** (Quality Loop)
2. **Fewer bugs** → **faster build cycles** (Product Loop) — less time fixing, more time building
3. **More features shipped** (Product Loop) → **new code to review** (Quality Loop)
4. **New review patterns** (Quality Loop) → **new prevention rules** (Process Loop)
5. **Better briefs** (Process Loop) → **higher first-attempt pass rate** (Product Loop)
6. **Higher pass rate** → **fewer wasted cycles** → **more capacity for features**

Each loop amplifies the others. The factory improves the product, improves its ability to find problems in the product, and improves its own ability to improve. This compounding effect is what makes the factory more than the sum of its parts.

### Convergence Signal

Each loop has its own convergence indicator:

- **Product Loop converged**: Discovery Team finds nothing new to build. All items from the north star are shipped or explicitly deferred with rationale. The CPO Team's directives are fully addressed.
- **Quality Loop converged**: Review Team finds zero findings across 3 consecutive cycles. QA Team passes on the first attempt for 3 consecutive cycles. No new patterns added to FACTORY_TRAPS.md.
- **Process Loop converged**: Factory metrics are stable across 5+ cycles. Build pass rate, items-per-cycle throughput, and cycle duration show no significant variation. No new prevention rules generated or removed.

**Important**: The factory does NOT self-certify convergence. When all three loops signal convergence simultaneously, the factory enters the Termination Gate (Section 15 of FACTORY_PROTOCOL.md). A 3-expert panel — independent of the factory — makes the final call.

---

## 11. Non-Negotiable Rules

These rules are the factory's constitution. They cannot be weakened, suspended, or circumvented by any team, any pipeline, any process improvement, or any number of consecutive cycles. Violating a non-negotiable rule is a Critical finding that halts the factory.

### R1: Orchestrator is SOLE writer of state files

Teams return structured reports. The orchestrator serializes all writes to every file in `docs/factory/state/`. No team, no agent, no subprocess writes directly to queue indexes, metrics files, cycle logs, or FACTORY_STATE.json.

**Exception**: Teams MAY create new files in `docs/factory/state/queue-details/` (e.g., `WI-5.md`, `RQ-3.md`). These are individual item detail files, not indexes. The orchestrator updates the index tables.

**Rationale**: Concurrent writes to shared files cause corruption. Serialized writes through a single actor eliminate race conditions entirely.

### R2: Teams are stateless

Every team is a fresh set of agents. All context comes from the brief. No team has memory of previous cycles. No team reads conversation history from a prior invocation.

**Implication**: Every brief must be self-contained. Include the project contract, relevant state, specific task, output format, and all constraints. Never assume a team "already knows" something.

**Rationale**: Stateless teams are predictable, reproducible, and crash-recoverable. If a team fails, re-dispatch with the same brief. No state to reconstruct.

### R3: Tests only go up

Every commit must maintain or increase the test count relative to the baseline in FACTORY_STATE.json. If a commit removes tests, it must add replacement tests first (in the same commit or an earlier commit in the same work branch).

**Enforcement**: The quality gate checks test count before and after. If `testsAfter < testsBefore`, the gate fails. No exceptions.

**Rationale**: Test count is a monotonic ratchet. It ensures the factory never trades coverage for velocity. A codebase with fewer tests is a codebase with more risk.

### R4: Build → QA is sequential; everything else is parallel

The Build Team must complete and commit code before the QA Team runs. QA must complete before Simulate (E2E) runs. This is a strict sequential chain within each cycle.

All other teams — Review, Oversight, Discovery, CPO, Factory Optimization — run in parallel with each other and in parallel with the Build→QA→Simulate chain.

**Rationale**: QA must test the actual committed code, not a work-in-progress. Parallel dispatch of independent teams maximizes throughput. The sequential chain ensures verification integrity.

### R5: Review freezes commit SHA

Before dispatching the Review Team, the orchestrator captures `git rev-parse HEAD`. The Review Team operates on this frozen SHA. If new commits land while the review is running, the Review Team does not see them — they will be reviewed in the next cycle.

**Enforcement**: The frozen SHA is recorded in the cycle file and passed in the Review Team's brief.

**Rationale**: Reviewing a moving target produces inconsistent findings. A frozen SHA gives the Review Team a stable artifact to analyze.

### R6: Max 3 review iterations per finding

If a finding has been through 3 cycles of fix → review → re-find, it is deferred with rationale. The orchestrator marks it as DEFERRED in the review queue with a summary of the 3 attempts and why they failed.

**Enforcement**: The orchestrator tracks iteration count per finding ID in FINDING_HISTORY.md.

**Rationale**: Infinite fix-review loops waste cycles without progress. Three iterations is enough to determine if a finding is genuinely hard. Deferred findings are documented and available for human review.

### R7: One item per Build cycle

The Build Team implements exactly one item per cycle. If an item is too large to implement in a single cycle (estimated >2 cycles), the Build Team must split it into smaller items first and implement only the first sub-item.

**Enforcement**: The orchestrator assigns exactly one item to the Build Team brief. The Build Team reports BLOCKED if the item requires splitting and returns the proposed split.

**Rationale**: Atomic changes are reviewable, testable, and revertable. Multi-item builds create entangled commits that are hard to reason about and impossible to cleanly revert.

### R8: Quality gate before merge

The Build Team commits on a work branch (`factory/wip-{item-id}`). E2E runs against the work branch. The work branch merges to `{working_branch}` only after all quality gates pass — unit tests, audit, prevention checks, and E2E.

**Enforcement**: The orchestrator controls the merge. No team has permission to merge to `{working_branch}` directly.

**Rationale**: The `{working_branch}` branch is the ratchet. It only advances on verified improvement. Failed attempts never pollute it.

### R9: Prevention rules are earned

A prevention rule (automated check in `docs/factory/checks/`) is only generated when a finding category reaches 3+ occurrences in FINDING_HISTORY.md. One-off findings do not justify automation.

**Enforcement**: The Self-Optimization pipeline checks occurrence counts before generating rules. The Factory Optimization Team validates this threshold.

**Rationale**: Premature automation creates maintenance burden and false positives. Three occurrences demonstrate a real pattern, not a coincidence.

### R10: Self-Opt never modifies project files

The Self-Optimization and Factory Optimization pipelines write only to factory-specific files:
- `docs/factory/state/*` (state files)
- `docs/factory/checks/*` (prevention checks)
- `docs/factory/FACTORY_PROTOCOL.md` (protocol improvements — parameter adjustments only)

They NEVER modify:
- `CLAUDE.md`
- `README.md`
- `AGENTS.md`
- `src/` (application source)
- `e2e/` (E2E tests)
- `test/` (unit tests)
- `docs/` outside `docs/factory/` (specs, ADRs, architecture, history)

**Rationale**: The factory optimizes itself. It does not unilaterally change project documentation, configuration, or non-factory code. Those changes go through the normal Product Loop (Discovery → Build → QA → Review).

### R11: Port safety is inviolable

All test ports must be >11000. Port 7777 (production default) and all ports <11000 are NEVER bound, killed, queried, or interfered with by any factory process.

**Enforcement layers**:
1. `check-port-safety.js` — scans staged files for hardcoded ports <11000
2. `cleanup-resources.js` — only kills processes on ports >11000
3. Build Team brief — explicit safety blacklist
4. FACTORY_TRAPS.md — documented as TRAP-005
5. Test infrastructure — uses `port: 0` (OS-assigned, >49152)

**Rationale**: Port 7777 may have a running production instance. Binding to it crashes the user's session. Ports below 11000 may be used by other services. The factory must be a good citizen.

### R12: Quality over cost

The factory never compromises quality to save tokens. Hard caps (30 cycles, $50 ceiling) are safety rails to prevent runaway operation, not budget targets to optimize toward. If a cycle needs a full E2E suite to verify a security change, it runs the full suite regardless of cost.

**Rationale**: A factory that ships buggy code to save money is worse than no factory at all. The cost caps exist to bound worst-case scenarios, not to pressure teams into cutting corners.

### R13: E2E gate is non-bypassable when spec files exist

When `.spec.js` files exist in `e2e/tests/`, end-to-end testing is MANDATORY before any QA PASS verdict. No team may report QA PASS without running E2E. No process improvement may weaken this gate. No number of consecutive unit test passes substitutes for E2E verification.

**Enforcement**: The orchestrator's GATE step (Section 8, step 6) independently verifies that E2E ran when spec files exist. If E2E was skipped, the QA PASS is invalidated and reclassified as QA FAIL.

**Rationale**: Unit tests verify components in isolation. E2E tests verify the system works end-to-end. For a web application with WebSocket communication, terminal emulation, and multi-session management, E2E is the only meaningful integration test.

### R14: No AI attribution

No `Co-Authored-By` trailers. No `Generated with` markers. No references to AI, LLM, Claude, GPT, or any model in commits, code, comments, documentation, or state files. The factory's output reads as human-authored.

**Enforcement**: `check-no-attribution.js` scans all staged files for attribution patterns. The check runs as part of every quality gate.

**Rationale**: Project policy. See CLAUDE.md global instructions.

### R15: Safety code is not complexity

Production error handlers, catch blocks, input validation, timeout guards, defensive null checks, and graceful degradation code are NEVER classified as "unnecessary complexity." The Simplicity Criterion (Section 1) applies to factory process, abstractions, and indirection — not to code that prevents crashes at 2am.

**The 2am test**: "Would a senior engineer on-call at 2am be grateful this code exists?" If the answer is yes, the code stays. Period.

**Enforcement**: The Review Team's brief explicitly flags removal of safety code as a Critical finding. The Build Team's safety blacklist prohibits removing try-catch blocks, error handlers, validation code, or timeout guards.

**Rationale**: The most expensive bug is the one that happens in production when no one is watching. Defensive code is insurance, not complexity.

### R16: The factory never asks the human for permission

The factory makes decisions and moves forward. It does not pause to ask "should I proceed?" or "is this the right approach?" or "do you want me to continue?" It evaluates conditions, applies the decision table, dispatches teams, and advances.

Human intervention is always welcome — the human can modify state files, adjust queues, add directives to CPO_DIRECTIVES.md, or halt the factory by deleting the cron. But the factory never solicits this intervention.

**Rationale**: An autonomous factory that stops to ask permission is not autonomous. The decision table, quality gates, and termination criteria encode the project's judgment. The factory executes that judgment.

### R17: Self-chaining plus heartbeat crons

The factory uses a dual cron system:

1. **Heartbeat cron** (recurring, every 12 minutes) — safety net that catches early completions and prevents stalls
2. **One-shot completion cron** (dynamic, per-dispatch) — enables fast cycle transitions by firing at estimated completion time

Both are session-only crons (they die when Claude exits). The heartbeat auto-expires after 7 days (Claude cron system limit).

No other cron patterns are permitted. No recurring cycle crons. No fixed-interval dispatch crons. The dual system provides both reliability (heartbeat) and responsiveness (one-shot).

**On session recovery**: Both crons must be re-created. The heartbeat is re-created at session start. The one-shot is re-created if a dispatch is in progress (determined from session-state.md).

**Rationale**: A single one-shot chain is fragile — if the cron misfires, the factory stalls until the human notices. A single recurring cron is wasteful — it fires even when no work is ready. The dual system combines the reliability of recurring with the responsiveness of one-shot.
---

## 12. Team Brief Templates

Every brief is self-contained. The orchestrator fills `{variables}` at dispatch
time. Managers receive the brief and nothing else -- no conversation history,
no cross-cycle memory, no access to this protocol document. If a piece of
context matters, it must be in the brief.

**Fallback rule**: Every brief references state files (e.g., `FACTORY_TRAPS.md`, `attempts.jsonl`, `FACTORY_METRICS.md`). If a referenced file does not exist (common on early cycles), the team must skip that input and proceed — NOT report BLOCKED. Only report BLOCKED if the primary input is missing (e.g., Build Team's `queue-details/{item-id}.md`).

**State file formats**: `WORK_QUEUE.md` and `REVIEW_QUEUE.md` are markdown tables (`| ID | Priority | Status | Source |`). `queue-details/WI-N.md` and `RQ-N.md` are freeform markdown with required sections: Why Now, Acceptance Criteria, Scope, Estimated Cycles. `FACTORY_METRICS.md` is a markdown table with one row per cycle. `attempts.jsonl` is one JSON object per line: `{"cycle": N, "item": "WI-N", "approach": "...", "status": "...", "learned": "..."}`. `FACTORY_TRAPS.md` is a numbered list of known patterns.

### 12.1 CPO Team Brief

```
You are the CPO Team Manager for Cycle {N}.

Your team: Visionary, Competitor Analyst, Lifecycle Auditor.
Coordinate them to produce a unified strategic assessment.

PROJECT: Node.js / Express -- Web-based multi-tool AI terminal interface
NORTH STAR: Browser-based multi-tool AI interface with multi-session support,
  cross-platform deployment, voice input, file browsing, mobile-responsive design.
  Publishable quality: npm + standalone binary.
CURRENT STATE: {summary from FACTORY_METRICS.md}

Read these files and distribute to your team:
- README.md
- docs/specs/ (component specifications)
- docs/factory/state/FACTORY_METRICS.md

Your task: Assess strategic direction and product lifecycle health.
- Visionary: evaluate alignment with north star, identify missed opportunities
- Competitor Analyst: research competitor features (other web-based AI terminals),
    identify gaps
- Lifecycle Auditor: evaluate development->testing->shipping pipeline health

Synthesize your team's findings into ONE report.
DO NOT implement anything. Create memos, items, and recommendations only.
DO NOT write to any state files.

Return:
  Status: SUCCESS | PARTIAL
  Vision Check: {aligned | drifting | blocked}
  Memos: [{title, rationale, priority, action}]
  Items Created: [WI-N, ...]
  Items Killed/Deferred: [{id, reason}]
  Fundamentals Assessment:
    reliability: pass | fail
    performance: pass | fail
    consistency: pass | fail
  Lifecycle Assessment:
    development: healthy | bottlenecked
    testing: adequate | gaps
    validation: passing | failing
    shipping: on_track | blocked
  Team Recommendations: [{team, action, change, reason}]
```

**When dispatched**: Every 10th cycle, or when the orchestrator detects strategic
drift (3+ consecutive Discovery cycles producing only P2 items). The CPO team
is the most expensive team and runs the least frequently.

**Orchestrator integration**: The orchestrator reads the CPO report and applies
memos as adjustments to the work queue. Killed/deferred items are removed from
the queue with the CPO's stated rationale. Team recommendations are logged in
`FACTORY_METRICS.md` and may influence subsequent briefs.

---

### 12.2 Research/Discovery Team Brief

```
You are the Research/Discovery Team Manager for Cycle {N}.

Your team: Product Scout, Gap Analyst, Competitor Researcher.

PROJECT: Node.js / Express -- Web-based multi-tool AI terminal
NORTH STAR: Browser-based multi-tool AI interface with multi-session support,
  cross-platform deployment, voice input, file browsing, mobile-responsive design.
  Publishable quality: npm + standalone binary.
TEST: npm test  CURRENT TESTS: {N}

Read these files to understand current state:
- CLAUDE.md (project instructions)
- docs/factory/state/FACTORY_TRAPS.md (known patterns)
- docs/factory/state/attempts.jsonl (last 20 entries -- avoid repeating failures)

Distribute tasks:
- Product Scout: Use Glob and Grep to survey the codebase. DO NOT read entire
    large files (server.js is 99KB, app.js is 216KB -- use line ranges). Scan
    for gaps against docs/specs/.
- Gap Analyst: Compare current functionality against north star. What is
    missing? What is broken? What friction exists for real users?
- Competitor Researcher: Research comparable tools (web-based terminals, AI
    coding interfaces). What features do they have that we lack?

Find 3-8 work items. Priority: P0 (blocks core) > P1 (significant) > P2 (polish)

For each item, create docs/factory/state/queue-details/WI-{N}.md with:
- Why now (who benefits, what friction it removes)
- Acceptance criteria (testable checklist, 3-8 items)
- Scope (files to modify -- specify line ranges for files >100 lines)
- Estimated cycles (1-2)
- Dependencies and risks

DO NOT write to WORK_QUEUE.md or any other state file.

Return:
  Status: SUCCESS | PARTIAL | BLOCKED
  Summary: {one line}
  Items Created: [WI-N, ...]
  Blockers: {if any}
```

**When dispatched**: Every 3rd cycle, or when both queues are empty.
Skipped if `(NEW + IN_PROGRESS) > 10` in the work queue.
Hard-skipped if queue depth exceeds 15.

**Orchestrator integration**: The orchestrator reads the returned items list,
validates that corresponding `WI-{N}.md` files exist in `queue-details/`,
and appends entries to `WORK_QUEUE.md` with priority and status `NEW`.

---

### 12.3 Oversight Team Brief

```
You are the Oversight Team Manager for Cycle {N}.

Your team: Designer Monitor, Architect Monitor, PM Monitor.
SCOPE: {lightweight | deep}
PROJECT: Node.js / Express -- Web-based multi-tool AI terminal
CURRENT STATE: {summary from FACTORY_METRICS.md}
CPO MEMOS: {list of active memos}

Read: FACTORY_METRICS.md, VERIFY_STATUS.md, recent CPO memos

Distribute tasks:
- Designer Monitor: Evaluate visual coherence, UX consistency, and
    mobile-first compliance. Target viewports: iPhone 14 (390x844),
    Pixel 7 (412x915), Desktop (1280x720). Check design system compliance,
    spacing consistency, touch target sizing (48px minimum).
- Architect Monitor: Build health (does npm test pass? does npm audit
    pass?), dependency hygiene (outdated deps, known vulns), tech debt
    trends (growing or shrinking), security posture (auth, rate limiting,
    path validation intact).
- PM Monitor: Work queue health (are items moving?), priority alignment
    with CPO vision (are we building the right things?), feature
    completeness against north star.

For deep audits: thorough scan of all relevant files. Use Glob and Grep
  to inspect code, not full file reads.
For lightweight audits: scan only files changed since last oversight cycle.

DO NOT implement anything. Findings and recommendations only.
DO NOT write to state files.

Return:
  Status: SUCCESS | PARTIAL
  Scope: {lightweight | deep}
  Findings: [{id, severity, category, description, recommendation}]
  Fundamentals:
    build_health: pass | fail
    dependency_hygiene: pass | warn | fail
    security_posture: pass | warn | fail
    ux_consistency: pass | warn | fail
  CPO Memo Actions: [{memo_id, action_taken, reason}]
```

**When dispatched**: Every 5th cycle (lightweight), every 10th cycle (deep),
or on demand when the CPO team flags concerns. Lightweight scope reviews only
recent changes; deep scope reviews the full relevant surface.

**Orchestrator integration**: Findings with severity Critical or Important are
converted to review queue items (`RQ-{N}.md`). Fundamentals are logged in
`FACTORY_METRICS.md`. CPO memo actions are recorded for traceability.

---

### 12.4 Build Team Brief

```
You are the Build Team Manager (Build Architect) for Cycle {N}.

Your team: Architect Agent, Engineer(s), Test Engineer, Integration Agent.
Scale: small (3), medium (4), large (6) based on item scope.

PROJECT: Node.js / Express (CommonJS, 2-space indent, single quotes, semicolons)
TEST: npm test  AUDIT: npm audit --audit-level=high
PREVENTION: node docs/factory/checks/run-checks.js --stage build
CURRENT TESTS: {N} (must not decrease)
KNOWN TRAPS: {list from FACTORY_TRAPS.md}

Your task: Implement {item ID}
Full details: docs/factory/state/queue-details/{item ID}.md

Pre-flight:
1. git checkout -b factory/wip-{item-id} (from {working_branch})
2. git status -- if dirty, stash with 'factory-recovery-cycle-{N}'

Read ONLY the files specified in the item scope. For large files (>100 lines),
read only relevant sections. server.js is 99KB, app.js is 216KB -- NEVER read
the whole file. Use line ranges.

SAFETY BLACKLIST -- you must NEVER:
- Remove try-catch blocks, error handlers, or validation code
- Remove defensive checks or timeout guards
- Hardcode ports below 11000
- Use string concatenation for file paths (use path.join())
- Skip spec updates when behavior changes (update docs/specs/)
- Weaken auth middleware (SI-1), rate limiting (SI-2), path validation (SI-3),
  session isolation (SI-4), or port safety (SI-5)
- Commit secrets, tokens, or credentials (SI-6)

Coordinate:
1. Architect: design approach, assign file ownership, define contracts between
   modules. No two agents write the same file.
2. Engineers: implement changes (disjoint files, frozen contracts). Follow
   CommonJS conventions. Use path.join() for all file paths.
3. Test Engineer: write unit + regression tests for every change. Tests in
   test/*.test.js. Minimum: one test per acceptance criterion.
4. Integration Agent: run quality gate, resolve conflicts, prepare final commit.

Quality gate (ALL must pass):
1. npm test -- count must be >= {N}
2. npm audit --audit-level=high -- must pass
3. node docs/factory/checks/run-checks.js --stage build -- must pass

If gate passes: commit with Conventional Commits format referencing {item ID}
  Example: feat(session): add idle timeout indicator (WI-42)
If gate fails: 2 attempts to fix. After 2 failed attempts:
  1. Revert all changes: git checkout .
  2. Confirm working tree is clean: git status
  3. Report BLOCKED with failure details

DO NOT merge into {working_branch}. DO NOT write state files. DO NOT push.

Return:
  Status: SUCCESS | PARTIAL | FAILED | BLOCKED
  Summary: {one line}
  Branch: factory/wip-{item-id}
  Build Plan: {files, contracts, risks}
  Files Changed: {N}
  Tests Before: {N}
  Tests After: {N}
  Commits: [{sha, message}]
  Key Decisions: [{decision, rationale}]
  Blockers: {if any}
```

**When dispatched**: Whenever the work queue or review queue has items with
status `NEW` or `READY`. Picks the highest-priority item. One item per cycle.

**Orchestrator integration**: The orchestrator reads the build report. On
`SUCCESS`, it proceeds to Simulate (E2E). On `BLOCKED` or `FAILED`, it updates
the item status in the work queue and logs the failure to `attempts.jsonl`.
After 3 consecutive failures on the same item, the item is deferred with
rationale.

**Team scaling**:
| Item Scope | Team Size | Composition |
|------------|-----------|-------------|
| 1-2 files, simple | 3 (small) | Architect + Engineer + Test Engineer |
| 3-5 files, moderate | 4 (medium) | Architect + 2 Engineers + Integration |
| 5+ files, complex | 6 (large) | Architect + 3 Engineers + Test + Integration |

---

### 12.5 QA Team Brief

```
You are the QA Team Manager for Cycle {N}.

Your team: Verification Agent, E2E Agent, Regression Agent.
PROJECT: Node.js / Express
TEST: npm test  PREVENTION: node docs/factory/checks/run-checks.js --stage verify
CURRENT TESTS: {N} (must not decrease)
BUILD REPORT: {summary -- files changed, commit SHA, branch name}

Your task: Independently verify the Build Team's work.

IMPORTANT: QA is independent of Build. You receive the build report but
you do NOT trust it. Verify everything yourself.

VERIFICATION AGENT:
- Run: npm test -- record pass count, fail count, total count
- Run: npm audit --audit-level=high
- Run: node docs/factory/checks/run-checks.js --stage verify
- Compare test count against baseline {N}. Any decrease is Critical.

E2E AGENT:
- Count spec files: find e2e/tests/ -name "*.spec.js" | wc -l
- If count > 0, E2E is MANDATORY:
  1. Run cleanup: node docs/factory/checks/cleanup-resources.js
  2. Start server: node bin/supervisor.js --port 11892 --no-auth
     (or appropriate test mode)
  3. Wait up to 30 seconds for server to be ready
  4. Run Playwright with rotation projects for this cycle:
     npx playwright test --config e2e/playwright.config.js --workers=2
       --project={rotation projects}
  5. If server fails to start: report FAIL. Do not skip.
  6. After test run: kill the server process, run cleanup again.
- e2e_tests.count == 0 when spec files exist is a FAIL, not a skip.

REGRESSION AGENT:
- Compare test counts (before build vs after build)
- Flag any test count decrease as Critical
- Check for new test files that lack assertions (empty tests)
- Verify no tests were renamed to hide failures

Rules:
- QA has VETO POWER -- if gate fails, build MUST be reverted
- Tests only go up (Rule R3)
- Flaky test protocol: run twice on failure. Pass on retry = flaky
  (log to FACTORY_TRAPS.md as a flaky test entry). Fail on retry =
  real failure (revert build branch).
- QA NEVER modifies source code. QA reads and runs only.
- QA reports are the source of truth for gate pass/fail.

Return:
  Status: PASS | FAIL
  Gate Results:
    unit_tests: {count, passed, failed}
    e2e_tests:
      spec_files_found: {N}
      server_started: true | false
      ran: true | false
      count: {N}
      passed: {N}
      failed: {N}
    prevention_checks: PASS | FAIL | SKIP
    audit: PASS | FAIL
  Regressions: [{test_name, error}]
  Test Count: {before, after, delta}
  Blockers: {if any}
```

**When dispatched**: After every Build cycle that reports `SUCCESS`. Never
dispatched if Build reports `BLOCKED` or `FAILED`.

**Orchestrator integration**: QA has absolute veto. If QA returns `FAIL`, the
orchestrator deletes the work branch and re-queues the item with the QA
failure details. If QA returns `PASS`, the orchestrator proceeds to merge
the work branch into `{working_branch}`.

**E2E rotation**: QA uses the same rotation schedule as Section 18. The E2E
Agent receives the rotation projects as part of the brief.

---

### 12.6 Review Team Brief

```
You are the Review Team Manager for Cycle {N}.

Your team: Security Reviewer, Correctness Reviewer, UX/A11y Reviewer,
  Performance Reviewer.
Assign each reviewer their domain. Deduplicate findings across reviewers.
On severity disagreements, default to the HIGHER classification.

PROJECT: Node.js / Express
FROZEN SHA: {sha}
PREVIOUS SHA: {prev_sha}
KNOWN TRAPS: {list from FACTORY_TRAPS.md}

Diff: git diff {prev_sha}..{frozen_sha}

Each reviewer scans the diff for issues in their domain:

SECURITY REVIEWER:
- Injection (SQL, command, template)
- Auth bypass (missing middleware, token leaks)
- Path traversal (string concat instead of path.join, missing validation)
- XSS (unescaped user input in HTML/terminal output)
- Secret leaks (tokens, keys, passwords in code or comments)
- WebSocket auth (unauthenticated message handling)

CORRECTNESS REVIEWER:
- Logic errors (off-by-one, wrong comparator, inverted condition)
- Race conditions (async without proper await, shared mutable state)
- Edge cases (empty input, null/undefined, boundary values)
- Dead code (unused imports, unreachable branches, commented-out code)
- Error handling gaps (unhandled promise rejections, missing catch)

UX/A11Y REVIEWER:
- WCAG AA compliance (contrast, focus indicators, landmarks)
- Keyboard navigation (tab order, focus traps, skip links)
- Screen reader support (aria-labels, role attributes, live regions)
- Focus management (modal focus traps, focus restoration)
- Mobile responsive (touch targets >=48px, viewport handling, scroll)

PERFORMANCE REVIEWER:
- Memory leaks (event listeners not removed, growing buffers, closures)
- Unnecessary work (redundant DOM queries, repeated computation)
- ConPTY buffer issues (Windows terminal output handling)
- WebSocket message flooding (missing throttle, unbounded queues)
- Large file handling (reading entire files into memory)

CRITICAL: Flag ANY removal of error handling, validation, catch blocks,
or defensive checks as a Critical finding. The Simplicity Criterion does
NOT apply to production safety code (Rule R13).

When the diff touches Security-Immutable files, apply heightened scrutiny:
- SI-1: src/utils/auth.js, auth middleware in src/server.js
- SI-2: Rate limiting configuration and middleware
- SI-3: Path validation in file browser and session store
- SI-4: Session isolation in src/utils/session-store.js
- SI-5: Port binding and configuration
- SI-6: Any file that might contain or reference secrets

Rules:
- Only HIGH CONFIDENCE findings (exact file:line + reproduction + fix)
- Severity: Critical | Important | Suggestion
- Isolation: reviewers receive only the diff and intent, NOT the design
  rationale. They must find problems independently.

Create docs/factory/state/queue-details/RQ-{N}.md per finding.
DO NOT write to REVIEW_QUEUE.md.

Return:
  Status: SUCCESS | PARTIAL | BLOCKED
  Frozen SHA: {sha}
  Previous SHA: {prev_sha}
  Findings: [{id, severity, category, file, line, description,
              reproduction, fix}]
  Traps Violated: [{trap_id, file, line}]
```

**When dispatched**: Every cycle, provided the diff between the previous
reviewed SHA and the current frozen SHA is non-empty. Skipped when there
are no code changes to review.

**Orchestrator integration**: Critical findings become `RQ-{N}` items in
the review queue with status `NEW` and priority P0. Important findings
become P1. Suggestions are logged in `FINDING_HISTORY.md` but do not
enter the queue unless they recur 3+ times. Trap violations increment
the trap's occurrence count.

---

### 12.7 Factory Optimization Team Brief

```
You are the Factory Optimization Team Manager for Cycle {N}.

Your team: Pattern Analyst, Velocity Engineer, Brief Optimizer.

Read these files:
- docs/factory/state/FINDING_HISTORY.md
- docs/factory/state/FACTORY_METRICS.md
- Last 10 cycle files from docs/factory/state/cycles/
- docs/factory/state/FACTORY_TRAPS.md
- docs/factory/state/SELF_OPT_LOG.md (if exists)

PATTERN ANALYST:
- Scan FINDING_HISTORY.md for categories with 3+ occurrences
- For each qualifying category, create a prevention check:
    docs/factory/checks/check-{name}.js
  The check must:
  - Accept FACTORY_REPO_ROOT env var for project root
  - Output JSON: { check, status, details }
  - Exit 0 on pass, 1 on fail
- Validate: run each new check against current code
- Reject any check with >20% false positive rate
- Review existing checks: if a check has >20% false positives across
  3+ cycles, remove it and log the removal reason

VELOCITY ENGINEER:
- Identify bottleneck teams and their root causes by analyzing cycle files
- Track these metrics across cycles:
  - Build first-pass rate (SUCCESS on first attempt / total builds)
  - Items completed per cycle (throughput)
  - Waste ratio (BLOCKED + FAILED cycles / total cycles)
  - Average cycle duration
- Recommend adjustments:
  - Timeout values (per-check, per-gate, per-cycle)
  - Parallelism levels (which steps can overlap)
  - Queue management (cap adjustments, priority rebalancing)

BRIEF OPTIMIZER:
- Review recent briefs and their corresponding reports
- Identify patterns that produced BLOCKED or PARTIAL results:
  - Were briefs missing critical context?
  - Were scope estimates too large?
  - Were acceptance criteria ambiguous?
- Propose concrete brief improvements (add/remove/rephrase sections)
- Update docs/factory/state/FACTORY_TRAPS.md with new patterns that
  have 2+ occurrences. Each trap entry must include:
  - Trap ID (TRAP-NNN)
  - Description
  - Occurrence count
  - Mitigation

CONSTRAINTS:
- Never modify CLAUDE.md, AGENTS.md, or docs/ outside factory/
- Never delete security-immutable prevention rules (check-port-safety.js,
  check-security-audit.js, check-no-attribution.js)
- New checks must follow the existing pattern in docs/factory/checks/

Log all decisions and changes to docs/factory/state/SELF_OPT_LOG.md

Return:
  Status: SUCCESS | PARTIAL
  Rules Generated: [{name, trigger_count}]
  Rules Removed: [{name, reason, false_positive_rate}]
  Patterns Added: [{id, description}]
  Velocity Findings: [{bottleneck, metric, recommendation}]
  Brief Improvements: [{team, change, reason}]
  Factory Metrics:
    cycle_time_avg: {minutes}
    build_pass_rate: {percent}
    items_per_cycle: {float}
    waste_ratio: {percent}
```

**When dispatched**: Every 5th cycle. May also be triggered when the waste
ratio exceeds 40% for 3 consecutive cycles.

**Orchestrator integration**: Generated check scripts are added to the
appropriate stage in `run-checks.js` (by the orchestrator, not the manager).
Trap updates in `FACTORY_TRAPS.md` are committed with the next cycle's
state update. Velocity recommendations are logged and applied at the
orchestrator's discretion within pre-defined bounds.

---

### 12.8 Brief Variable Reference

The orchestrator populates these variables when constructing briefs:

| Variable | Source | Example |
|----------|--------|---------|
| `{N}` (cycle) | `FACTORY_STATE.json`.currentCycle | 14 |
| `{N}` (tests) | Last `npm test` output or cycle file | 420 |
| `{sha}` | `git rev-parse HEAD` at dispatch | a1b2c3d |
| `{prev_sha}` | `FACTORY_STATE.json`.lastReviewedSha | e4f5g6h |
| `{summary from FACTORY_METRICS.md}` | First 10 lines of FACTORY_METRICS.md | (text) |
| `{list from FACTORY_TRAPS.md}` | All TRAP-NNN entries, one per line | TRAP-001: ... |
| `{north star}` | Literal from Section 2 of FACTORY_PROTOCOL.md | (text) |
| `{item ID}` | Highest-priority NEW item from WORK_QUEUE.md | WI-42 |
| `{rotation projects}` | Computed from cycle mod 5 (Section 18) | golden-path,functional-core |
| `{lightweight \| deep}` | `cycle % 10 == 0 ? "deep" : "lightweight"` | lightweight |

---

## 13. Local Quality Gate

All quality gates run locally. No CI dependency. The factory has full control
over every step.

### 13.1 Gate Composition

```
+---------------------------------------------+
|              LOCAL QUALITY GATE              |
|                                             |
|  +-----------+ +--------------+             |
|  |  npm test | |  npm audit   |  parallel   |
|  |  (unit)   | |  (security)  |             |
|  +-----------+ +--------------+             |
|  +-----------+ +--------------+             |
|  | prevention| |  attribution |  parallel   |
|  |  checks   | |  scan        |             |
|  +-----------+ +--------------+             |
|                                             |
|  All must pass --> commit on work branch     |
|                                             |
|  +------------------------------+           |
|  |  Playwright E2E subset      | sequential |
|  |  --workers=2 --project=...  | (after     |
|  +------------------------------+  commit)  |
|                                             |
|  E2E pass --> merge to {working_branch}    |
|  E2E fail --> delete work branch, re-queue   |
+---------------------------------------------+
```

### 13.2 Gate Steps in Detail

**Step 1: Parallel checks** (run concurrently)

| Check | Command | Pass Criteria | Timeout |
|-------|---------|---------------|---------|
| Unit tests | `npm test` | Exit 0, count >= baseline | 60s |
| Security audit | `npm audit --audit-level=high` | Exit 0 (no high/critical) | 60s |
| Prevention | `node docs/factory/checks/run-checks.js --stage build` | All checks pass | 60s |
| Attribution | `node docs/factory/checks/check-no-attribution.js` | No AI markers found | 30s |

All four run in parallel. Total wall time: <60 seconds on 8+ cores.

**Step 2: Commit** (sequential, only if Step 1 passes)

Commit to the work branch with Conventional Commits format. The commit message
references the item ID.

**Step 3: E2E subset** (sequential, only after commit)

| Check | Command | Pass Criteria | Timeout |
|-------|---------|---------------|---------|
| E2E subset | `npx playwright test --config e2e/playwright.config.js --workers=2 --project=<rotation>` | All selected tests pass | 5 min |

On E2E failure: retry once (flaky test protocol). If retry also fails,
delete the work branch and re-queue the item.

**Step 4: Merge** (sequential, only if Step 3 passes)

```bash
git checkout {working_branch}
git merge --ff-only factory/wip-{item-id}
git branch -d factory/wip-{item-id}
```

Fast-forward only. If fast-forward is not possible (diverged history),
rebase the work branch first.

### 13.3 Performance Budget

| Step | Expected Duration | Hard Timeout |
|------|-------------------|-------------|
| Unit tests | <30 seconds | 60 seconds |
| Security audit | <15 seconds | 60 seconds |
| Prevention checks | <30 seconds (parallel) | 60 seconds |
| Attribution scan | <10 seconds | 30 seconds |
| **Parallel total** | **<30 seconds** | **60 seconds** |
| E2E subset (1-3 projects, workers=2) | 2-4 minutes | 5 minutes |
| **Total per gate** | **<5 minutes** | **6 minutes** |

If any step exceeds its hard timeout, it is treated as a failure. The Build
team gets 2 attempts to fix before reporting BLOCKED.

### 13.4 Gate Failure Handling

| Failure | Action |
|---------|--------|
| Unit test count decreased | Critical -- Build must add replacement tests |
| Unit test fails | Build attempts fix (2 tries), then BLOCKED |
| npm audit high/critical | Build must resolve vulnerability or BLOCKED |
| Prevention check fails | Build must fix violation or BLOCKED |
| Attribution marker found | Build must remove marker (always fixable) |
| E2E fails, passes on retry | Log as flaky, proceed with merge |
| E2E fails on retry | Delete work branch, re-queue item |

---

## 14. Port Safety Protocol

Port safety is a Security-Immutable (SI-5) constraint. It is enforced at
five independent layers. No single point of failure can compromise it.

### 14.1 Protected Ports Table

| Port | Owner | Rule |
|------|-------|------|
| 7777 | ai-or-die production server | NEVER touch -- do not bind, kill, or query processes on this port |
| 1-10999 | System and other applications | NEVER bind test infrastructure to these ports |
| 11000+ | Factory test zone | Safe for test servers, Playwright, ephemeral ports |

Port 7777 is the default production port configured in the application. If a
user is running ai-or-die while the factory operates, binding or killing port
7777 would destroy their session. This is the primary reason port safety is
inviolable.

### 14.2 Enforcement Layers

**Layer 1: Prevention check (check-port-safety.js)**

Scans staged files for hardcoded port numbers below 11000. Runs as part of
the build-stage prevention suite. Catches violations before they reach a
commit.

**Layer 2: Cleanup sweep (cleanup-resources.js)**

The resource cleanup script only kills processes on ports >11000. The kill
logic explicitly filters out any port <= 10999. Even a bug in the process
enumeration cannot cause it to kill a protected port.

**Layer 3: Manager briefs**

Every Build Team brief includes the safety blacklist, which explicitly states:
"Hardcode ports below 11000" as a prohibited action. Every QA brief references
test port constraints.

**Layer 4: FACTORY_TRAPS.md**

The known traps document includes a trap entry for port safety, ensuring that
Discovery and Self-Optimization teams are aware of the constraint when
evaluating the codebase.

**Layer 5: Test infrastructure**

The application's test helpers use `port: 0` (OS-assigned, typically 49152+)
or explicit high ports (>11000). The `spawnCli()` helper uses the 49152-65534
range. Both are well above the protected boundary.

### 14.3 Port Verification

Before each cycle, the cleanup sweep verifies port 7777 status as an
informational check:

```
Port 7777: [in use by PID 1234 | not in use]
```

This is logged but NEVER acted upon. The factory does not start, stop, or
modify anything on port 7777 under any circumstance.

**Known limitation**: `check-port-safety.js` uses regex-based detection which has imperfect comment handling. It also only scans test files (`test/`, `e2e/`, `docs/factory/`), not `src/`. The production port 7777 in `src/server.js` is trusted, not scanned. The 5-layer defense (prevention check + cleanup sweep + manager briefs + FACTORY_TRAPS + test infrastructure defaults) compensates for any single layer's weakness.

### 14.4 What Happens if a Test Needs a Specific Port

If a work item requires a specific test port:
1. The port MUST be >= 11000
2. The port should be documented in the item's acceptance criteria
3. After the test, the port must be released (process killed by cleanup)
4. Prefer `port: 0` over hardcoded ports whenever possible

---

## 15. Resource Cleanup Protocol

Every cycle starts with a cleanup sweep. The sweep runs before any other
factory activity to ensure a clean environment.

### 15.1 Invocation

```bash
node docs/factory/checks/cleanup-resources.js
```

This is also available as a stage in the check runner:

```bash
node docs/factory/checks/run-checks.js --stage cleanup
```

### 15.2 What Gets Cleaned

**1. Orphaned Node.js processes on ports >11000 (older than 10 minutes)**

| Platform | Detection | Termination |
|----------|-----------|-------------|
| Windows | `netstat -ano` filtered for LISTENING on >11000 | `taskkill /F /PID <pid>` |
| Linux/macOS | `lsof -iTCP -sTCP:LISTEN` filtered for >11000 | `kill -9 <pid>` |

Only processes older than 10 minutes are killed. This avoids interfering
with tests that are actively running.

**2. Orphaned Chromium processes (headless, older than 10 minutes)**

Playwright spawns headless Chromium for E2E tests. If a test crashes, the
browser process may remain. The cleanup sweep finds Chromium processes with
`--headless` in their command line and kills those older than 10 minutes.

**3. Stale temp directories**

Pattern: `ai-or-die-test-*` in `os.tmpdir()`. Directories older than 5
minutes are removed recursively. These are created by test helpers for
isolated test environments.

**4. Stale lock files**

The factory lock file (`.factory-lock`) is deleted if older than 30 minutes.
This handles the case where a previous cycle crashed without releasing its
lock.

### 15.3 What is NEVER Cleaned

| Resource | Reason |
|----------|--------|
| Anything on port 7777 | Production port (SI-5) |
| Anything on ports below 11000 | Outside factory's domain |
| User's browser processes | Not headless, not factory-owned |
| Non-test Node.js processes | Cannot reliably distinguish |
| Files outside tmpdir and docs/factory/state/ | Factory's scope boundary |

### 15.4 Cleanup Verification

The cleanup script outputs a JSON report:

```json
{
  "check": "cleanup-resources",
  "status": "pass",
  "details": {
    "orphaned_node_killed": 0,
    "orphaned_chromium_killed": 0,
    "temp_dirs_removed": 2,
    "stale_locks_removed": 0,
    "port_7777_status": "not in use"
  }
}
```

The orchestrator logs this in the cycle file but does not gate on it.
Cleanup is best-effort -- a failure to clean does not block the cycle.

---

## 16. State File Integrity

All factory state lives in `docs/factory/state/`. The orchestrator is the
sole writer (Rule R1). This section documents the mechanisms that prevent
corruption.

### 16.1 Atomic Writes on Windows

**Problem**: `fs.rename()` fails across drives on Windows. If the repo is
on drive D: and `os.tmpdir()` is on C:, a write-to-temp-then-rename pattern
will throw `EXDEV`.

**Solution**: All temp files are created in the SAME directory as the target:

```javascript
const crypto = require('crypto');
const fs = require('fs');

function atomicWriteSync(targetPath, content) {
  const tempPath = targetPath + '.tmp-' + crypto.randomUUID().slice(0, 8);
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, targetPath);
}
```

The `renameSync` is atomic on the same filesystem. The temp file name
includes a random suffix to prevent collisions if multiple writes happen
in rapid succession (though Rule R1 makes this theoretically impossible).

This matches the pattern used by `src/utils/session-store.js` in the
production codebase.

### 16.2 Per-Cycle Log Files

Each cycle writes its own file rather than appending to a shared log:

```
docs/factory/state/cycles/cycle-001.json
docs/factory/state/cycles/cycle-002.json
docs/factory/state/cycles/cycle-003.json
...
```

This eliminates append-race issues and makes each cycle's record
independently readable and recoverable. Each file is a complete JSON object:

```json
{
  "cycle": 1,
  "startedAt": "2026-04-01T10:00:00Z",
  "completedAt": "2026-04-01T10:07:30Z",
  "pipelines": ["review", "discovery"],
  "itemsCompleted": [],
  "itemsAdded": ["WI-1", "WI-2"],
  "testsBefore": 420,
  "testsAfter": 420,
  "buildResult": null,
  "e2eResult": null,
  "estimatedCost": 2.50,
  "teams": {
    "review": {
      "status": "SUCCESS",
      "findings": 0,
      "duration_seconds": 45
    },
    "discovery": {
      "status": "SUCCESS",
      "itemsCreated": 2,
      "duration_seconds": 120
    }
  },
  "notes": ""
}
```

**Retention**: The last 50 cycle files are kept in `cycles/`. Older files
are moved to `docs/factory/state/archive/` during the Self-Optimization
pass. The archive is never read during normal operation.

### 16.3 Lock File Protocol

**Path**: `docs/factory/state/.factory-lock`

**Contents**:

```json
{
  "cycle": 14,
  "timestamp": "2026-04-01T10:00:00Z",
  "pid": 12345
}
```

**Creation**: Exclusive write flag prevents two cycles from acquiring the
lock simultaneously:

```javascript
fs.writeFileSync(lockPath, JSON.stringify(lockData), { flag: 'wx' });
```

The `wx` flag causes the write to fail if the file already exists. This is
the filesystem equivalent of a mutex.

**Lifecycle**:

| State | Lock Age | Action |
|-------|----------|--------|
| Lock exists, < 30 minutes old | Fresh | Another cycle is running. Skip this cycle. |
| Lock exists, >= 30 minutes old | Stale | Previous cycle crashed. Delete lock and proceed. |
| Lock does not exist | None | Acquire lock and proceed. |

**Release**: The orchestrator deletes the lock file at the end of every
cycle, whether the cycle succeeded or failed. The delete is in a `finally`
block to ensure it runs even on errors.

### 16.4 Serialized Writes

Rule R1 is absolute: the orchestrator is the sole writer of state files.
Managers create only queue-detail files (`WI-{N}.md`, `RQ-{N}.md`) in the
`queue-details/` subdirectory. They never write to:

- `FACTORY_STATE.json`
- `WORK_QUEUE.md`
- `REVIEW_QUEUE.md`
- `VERIFY_STATUS.md`
- `FACTORY_METRICS.md`
- `FINDING_HISTORY.md`
- `FACTORY_TRAPS.md` (except Factory Optimization team, which appends only)
- Any `cycles/cycle-NNN.json` file

This eliminates all concurrent-write scenarios. The orchestrator processes
manager reports sequentially and writes state files one at a time using
the atomic write pattern.

### 16.5 State File Size Bounds

| File | Max Size | Enforcement |
|------|----------|-------------|
| WORK_QUEUE.md | 20 lines (items) | Orchestrator truncates completed items |
| REVIEW_QUEUE.md | 20 lines (items) | Orchestrator truncates resolved items |
| FACTORY_METRICS.md | 60 lines (last 50 cycles + header) | Rolling window |
| FINDING_HISTORY.md | 100 lines | Aggregate counts, not individual entries |
| FACTORY_TRAPS.md | 50 entries | Self-Opt removes low-value traps |
| attempts.jsonl | 100 entries | Oldest entries dropped on append |
| cycles/ directory | 50 files | Older archived by Self-Opt |

These bounds ensure the orchestrator's READ phase stays under 5K tokens
total, keeping context window usage minimal.

---

## 17. Cost Observability

Cost is tracked for observability and velocity analysis. It is NOT used to
reduce thoroughness. Quality gates, review rigor, and test requirements are
never relaxed to save cost (Rule R12: quality over cost).

### 17.1 Per-Cycle Cost Estimates

| Cycle Type | Teams Dispatched | Typical Cost |
|-----------|-----------------|-------------|
| Light (Review only) | 1 | ~$1.50 |
| Normal (Review + Build + QA) | 3 | ~$4-6 |
| Heavy (Review + Build + QA + Discovery) | 4 | ~$8-12 |
| Deep audit (+ Oversight deep + Factory-Opt) | 6 | ~$12-18 |
| Termination (7-team sign-off + 3-expert panel) | 10 | ~$15-25 |

Estimates are based on typical input sizes and manager complexity. Actual
cost depends on the volume of code changes, the size of the diff under
review, and the complexity of the work item.

### 17.2 Advisory Thresholds

These thresholds trigger self-assessment, NOT automatic termination. The
factory evaluates whether continued operation is justified and documents
its reasoning.

| Threshold | Value | Triggered Action |
|-----------|-------|-----------------|
| Cycle advisory | 30 cycles | Self-assessment: Is the factory making forward progress? Are items being completed? Is the codebase measurably improving? |
| Cost advisory | $50 cumulative | Self-assessment: Is the spending justified by output? What is the cost per completed item? Is quality improving? |
| Idle advisory | 5 consecutive idle cycles | Self-assessment: Has the factory converged? Are all queues empty? Is there remaining valuable work? |
| Queue advisory | 15 items in work queue | Discovery pauses. Factory focuses on execution. Queue must drop below 10 before Discovery resumes. |

**Self-assessment format**: The orchestrator writes a brief assessment to
the cycle file's `notes` field explaining why it is or is not terminating.
This creates an audit trail.

**Distinction from auto-termination**: The auto-termination triggers in
`FACTORY_STATE.json` (cycle cap, cost ceiling, idle cap) are hard stops.
Advisory thresholds are soft -- they prompt reflection but allow the
factory to continue if the assessment is positive.

### 17.3 Cost Tracking Mechanism

Each cycle file records `estimatedCost` based on the number and type of
teams dispatched. The orchestrator maintains a running total in
`FACTORY_STATE.json`:

```json
{
  "currentCycle": 14,
  "cumulativeCost": 42.50,
  "cycleCapRemaining": 16,
  "consecutiveIdleCycles": 0
}
```

The Factory Optimization team reads cost data from `FACTORY_METRICS.md`
to compute velocity metrics:

- **Cost per item**: `cumulativeCost / itemsCompleted`
- **Cost efficiency trend**: Is cost per item improving or degrading?
- **Waste cost**: Cost of cycles that produced no completed items

These metrics inform process improvements but NEVER reduce review
thoroughness or test coverage.

### 17.4 Cost Allocation by Team

Approximate per-dispatch cost by team (for estimation purposes):

| Team | Typical Agents | Est. Cost per Dispatch |
|------|---------------|----------------------|
| CPO | 3 (Visionary, Analyst, Auditor) | $2-4 |
| Research/Discovery | 3 (Scout, Gap, Competitor) | $1.50-3 |
| Oversight | 3 (Designer, Architect, PM) | $1.50-3 |
| Build | 3-6 (varies by item scope) | $2-6 |
| QA | 3 (Verification, E2E, Regression) | $1.50-3 |
| Review | 4 (Security, Correctness, UX, Perf) | $2-4 |
| Factory Optimization | 3 (Pattern, Velocity, Brief) | $1.50-3 |

Orchestrator overhead per cycle: ~$0.50 (state reads + decision + writes).

---

## 18. E2E Test Rotation Schedule

Not all E2E projects run every cycle. The rotation balances thoroughness
with speed. Full suite runs are reserved for critical checkpoints.

### 18.1 Rotation Table (cycle mod 5)

| Cycle mod 5 | Projects | Purpose |
|-------------|----------|---------|
| 0 | `golden-path`, `functional-core` | Smoke -- core workflows (session create, terminal I/O, reconnect) |
| 1 | `functional-extended`, `new-features`, `voice-e2e` | Extended features + voice input (multi-session, folder browser, settings, STT) |
| 2 | `mobile-iphone`, `mobile-pixel`, `integrations` | Mobile viewports + third-party integrations |
| 3 | `power-user-flows`, `ui-features` | Power user workflows (keyboard shortcuts, split panes) + UI polish |
| 4 | **FULL SUITE** (all non-skipped projects) | Comprehensive validation across all dimensions |

**Project list for full suite (cycle mod 5 == 4)**:

```
golden-path
functional-core
functional-extended
new-features
mobile-iphone
mobile-pixel
integrations
power-user-flows
ui-features
mobile-flows
mobile-sprint1
mobile-sprint23
mobile-journeys
ux-features
voice-e2e
restart
```

### 18.2 Always Skipped in Factory

| Project | Reason | Conditions to Re-enable |
|---------|--------|------------------------|
| `visual-regression` | Screenshot baselines drift with OS, font rendering, and display scaling changes. Produces false failures on different machines. | Stable baseline generation across platforms |
| `voice-real-pipeline` | Requires downloading a 670MB speech recognition model. Environment dependency too heavy for factory cycles. | Model pre-cached in factory environment |

These projects are skipped in ALL factory cycles including full suite runs.
They are tested only in CI (GitHub Actions) where the environment is
controlled.

### 18.3 Special Triggers

Certain conditions override the rotation schedule and force a full suite run:

| Trigger | When | Rationale |
|---------|------|-----------|
| Pre-merge to main | Before creating PR from {working_branch} to main | Final validation -- rotation subsets are insufficient for merge confidence |
| Build touches 5+ files | Next Simulate step after such a build | Large changes have higher regression risk |
| Security-sensitive code touched | Next Simulate step | Auth, rate limiting, path validation, session isolation changes need full coverage |
| SYSTEMIC_BLOCK resolution | After unblocking a systemic issue | Systemic issues may have caused cascading failures |
| 3+ items completed since last full suite | Next Simulate step | Accumulated changes may interact in unexpected ways |

### 18.4 Rotation Computation

The orchestrator computes the rotation at dispatch time:

```javascript
function getE2EProjects(cycle) {
  const ALWAYS_SKIP = ['visual-regression', 'voice-real-pipeline'];
  const ROTATION = [
    ['golden-path', 'functional-core'],
    ['functional-extended', 'new-features'],
    ['mobile-iphone', 'mobile-pixel', 'integrations'],
    ['power-user-flows', 'ui-features'],
    null, // null = full suite
  ];

  const slot = cycle % 5;
  if (slot === 4) {
    // Full suite: all projects except always-skipped
    return getAllProjects().filter(p => !ALWAYS_SKIP.includes(p));
  }
  return ROTATION[slot];
}
```

The returned project list is passed to Playwright via `--project=`:

```bash
npx playwright test --config e2e/playwright.config.js \
  --workers=2 \
  --project=golden-path \
  --project=functional-core
```

### 18.5 E2E Timing Budget

| Rotation | Projects | Expected Duration | Hard Timeout |
|----------|----------|-------------------|-------------|
| mod 0 (smoke) | 2 | 1-2 minutes | 3 minutes |
| mod 1 (extended) | 2 | 2-3 minutes | 4 minutes |
| mod 2 (mobile) | 3 | 2-4 minutes | 5 minutes |
| mod 3 (power) | 2 | 2-3 minutes | 4 minutes |
| mod 4 (full) | 15 | 5-10 minutes | 15 minutes |

Workers are always set to 2 (`--workers=2`) to balance speed with resource
usage. Higher worker counts risk port conflicts and memory exhaustion on
machines also running the production server.

### 18.6 Flaky Test Protocol for E2E

When an E2E test fails:

1. **First failure**: Retry the entire project once.
2. **Pass on retry**: Log as flaky in the cycle file and add a trap entry
   (`TRAP-FLAKY-{test-name}`) to `FACTORY_TRAPS.md`. Proceed with merge.
3. **Fail on retry**: Real failure. Delete the work branch. Re-queue the
   item with the failure details appended to its queue-detail file.

Flaky tests that appear in 3+ cycles are escalated to the work queue as
a P1 item: "Fix flaky E2E test: {test-name}".

---

*End of Part 3. See `FACTORY_PROTOCOL.md` for Sections 1-11 and 19-20.*

---

## 19. Convergence and Termination

The factory has ONE stopping condition: **every permanent team independently signs off that the north star is achieved or exceeded on all fronts.** There is no other stopping condition. There is no timeout. There is no "max convocations" escape hatch. The factory runs until unanimous sign-off or until the human operator explicitly stops it.

### The North Star Sign-Off

The factory's north star (defined in the project contract and README) is the bar. Every team evaluates the product against this north star from their expert perspective. The question each team must answer:

> **"Is this a reliable, consistent, beautiful, frictionless, robust, working, functional, polished product that achieves or exceeds the north star — verified with real evidence from my domain?"**

The answer must be **YES** from ALL teams, backed by specific evidence. "Looks good to me" is not evidence. Each team must cite specific verification: test results, E2E coverage, code review findings (or lack thereof), performance measurements, accessibility audit results.

### Who Must Sign Off

ALL 7 permanent teams must independently sign off. The orchestrator collects sign-offs and does NOT terminate until all 7 are received.

| Team | What they sign off on | Evidence required |
|------|----------------------|-------------------|
| **CPO Team** | Vision achieved. North star met or exceeded. No missing table-stakes. Competitor parity. | Feature completeness checklist, competitor gap analysis, workflow coverage |
| **Research/Discovery Team** | All gaps found and addressed. No remaining opportunities worth pursuing. | Gap analysis showing zero uncovered items, north star alignment report |
| **Oversight Team** | Product polished, consistent across all viewports. Architecture healthy. Priorities aligned. | Designer audit (mobile + desktop), architect assessment, PM queue report |
| **Build Team** | Code clean, well-structured, tested. No known bugs unfixed. Every feature has tests. | Test count, build pass rate, code quality metrics |
| **QA Team** | Everything works. All E2E pass on rotation. No regressions. No flaky tests. | E2E results, test count, visual regression status |
| **Review Team** | Zero unresolved Critical or Important findings. No security vulnerabilities. | Clean review queue, finding history showing all resolved |
| **Factory Optimization Team** | Factory healthy. No recurring patterns unfixed. Prevention rules effective. | Factory metrics, pattern analysis, velocity trends |

### Sign-Off Pre-conditions

The orchestrator enters sign-off mode when ALL of these are TRUE:
- Both queues empty (WORK_QUEUE + REVIEW_QUEUE have zero NEW or IN_PROGRESS items)
- Zero remaining tasks or pending items in ANY pipeline
- Last 3 Review cycles produced zero Critical or Important findings
- Last Discovery run produced zero new items
- Zero unresolved Critical or Important findings in either queue
- All Suggestion-severity items fixed or explicitly deferred with rationale

### Sign-Off Process

1. Orchestrator dispatches ALL 7 teams simultaneously with the sign-off brief:
   ```
   The factory is evaluating whether the north star has been achieved.
   Your task: Independently evaluate whether this product meets the bar
   from your team's expert perspective.

   North star: {from README / project contract}

   Return:
     Verdict: SIGN_OFF | DO_NOT_SIGN_OFF
     Confidence: 0-100%
     Evidence: [specific verification data from your domain]
     Remaining Issues: [anything that prevents sign-off]
   ```

2. **Unanimous SIGN_OFF required.** All 7 teams must return `Verdict: SIGN_OFF` with `Confidence >= 90%`.

3. If ANY team says `DO_NOT_SIGN_OFF`: log remaining issues, create work items, resume main loop.

4. **There is NO escape hatch.** The factory runs until all 7 teams agree, or the human stops it.

### The 7-Expert Adversarial Panel (Final Validation)

AFTER all 7 teams sign off, the orchestrator runs one final adversarial validation — 7 independent expert agents, each tasked with finding reasons the product should NOT ship.

| Expert | Lens | "Should NOT ship if..." |
|--------|------|------------------------|
| **Security Engineer** | Attack surface, auth, injection, secrets | Any unmitigated vulnerability. Input validation gap. Secret in code/logs. |
| **Reliability Engineer** | Error handling, edge cases, crashes | Any unhandled error path. Missing timeout/retry. Crash scenario not tested. |
| **UX/A11y Specialist** | WCAG, keyboard nav, screen reader | Any WCAG AA violation. Keyboard trap. Unlabeled interactive element. |
| **Performance Engineer** | Memory leaks, latency, scalability | O(n²) in hot path. Memory leak. Unnecessary re-render. |
| **Architecture Reviewer** | Coupling, patterns, tech debt | Architectural smell costing 10x to fix later. |
| **Product Manager** | Feature completeness, user workflows | Broken core workflow. Dead-end UX. Missing table-stakes feature. |
| **QA/Testing Specialist** | Coverage, quality, edge cases | Untested critical path. Assertion-free tests. Flaky tests. |

Each expert receives:
1. Full codebase (read access)
2. FACTORY_METRICS.md
3. FACTORY_TRAPS.md
4. North star / README

They are NOT told: what others found, that the factory wants to stop, internal convergence metrics.

### The Bar

The bar is not "good enough." The bar is: **"I would mass-deploy this to every developer on the planet tomorrow and sleep soundly."**

### Termination Carve-Out

Critical security or reliability findings block termination regardless of panel convocation count. If a Critical finding remains unresolved, the factory MUST continue.

### After Termination

1. **MANDATORY: Full E2E suite** — Run all non-skipped Playwright projects locally. BLOCKING gate.
   ```
   npx playwright test --config e2e/playwright.config.js --workers=2
   ```
2. Final commit: update FACTORY_METRICS, VERIFY_STATUS, docs
3. Write `docs/factory/state/SHIP_REPORT.md` with:
   - Each team's sign-off verdict and evidence
   - Each expert's verdict and key findings
   - Final metrics (tests, build pass rate, total cycles)
   - What the factory learned (process improvements made)
4. Archive factory state files to `docs/factory/state/archive/`
5. Delete crons (CronDelete)
6. Merge to main via PR (if desired)


---

## 20. Crash Recovery

The factory is designed to survive crashes, context compaction, and session restarts. Every recovery scenario follows the same principle: trust the files over memory, trust git over state files, and re-create the orchestrator from scratch.

### Scenario 1: Mid-cycle crash (orchestrator dies while teams run)

1. Read `session-state.md` — cycle number and which teams were dispatched.
2. Read last cycle file from `docs/factory/state/cycles/` — check if cycle completed.
3. `git log --oneline -10` — check if Build commits landed.
4. `git status` — if dirty, stash with `git stash push -m 'factory-recovery-cycle-N'`.
5. **Decision**: If Build committed but QA/WRITE did not complete, run QA next cycle. If no commit, treat cycle as not started.
6. Resume from next cycle number.

### Scenario 2: Post-compaction recovery (Claude auto-compacted context)

1. Re-read `session-state.md` — external memory with cycle number, active work.
2. Re-read this file (`docs/factory/FACTORY_PROTOCOL.md`) — re-anchor on decision table, teams, rules.
3. Re-read `CLAUDE.md` — project contract.
4. Re-create dual crons (heartbeat + one-shot).
5. `git log --oneline -5` — verify state matches reality.
6. Resume from current cycle in session-state.md.

### Scenario 3: Dirty tree on startup

1. `git status` shows modified non-state files.
2. These are partial Build changes from a crashed team.
3. `git stash push -m 'factory-recovery-cycle-N-dirty-tree'` — preserve but remove.
4. Log stash in cycle file with `"notes": "recovered dirty tree from crash"`.
5. Reset the item to NEW status so next Build can retry.
6. Resume from next cycle.

### Scenario 4: Stale lock

1. Check `.factory-lock` timestamp.
2. If >30 minutes old: stale — delete lock, log `"notes": "cleared stale lock"`.
3. If not expired: another orchestrator may be running — wait or exit.
4. After clearing: resume normal startup.

### Scenario 5: Session restart (new Claude session)

Follow the Quick Start (Section 1):
1. Read session-state.md
2. Read this file, CLAUDE.md, queue files
3. git log, git status
4. Set up dual crons
5. Enter main loop

### State files as recovery source

- All coordination in files, not memory — no in-memory state required to resume.
- Teams are stateless fresh agents — re-dispatch with same brief if needed.
- Per-cycle files are atomic (one file per cycle) — no partial-append corruption.
- FACTORY_STATE.json is single source of truth for cycle number and cost.
- SYSTEMIC_BLOCKS.md survives crashes — blocks persist across sessions.


---

## 21. Failure Defenses

Seventeen adversarial scenarios were stress-tested against this protocol. These defenses address every identified failure mode.

### Defense 1: Queue Starvation (all items BLOCKED)

- **Detection**: Before dispatching Build, count items by status. If all remaining items are BLOCKED for 2+ consecutive cycles, halt and log: "No forward progress."
- **Queue depth cap**: Skip Discovery if `(NEW + IN_PROGRESS) > 15`. Discovery generates 3-8 items max.
- **Conflict detection**: New items checked for contradicting intent against existing queue.
- BLOCKED items include a `reason` field. If >3 blocked for same reason, re-run Discovery to decompose.

### Defense 2: Flaky Tests

- If Verification or E2E fails, re-run once. Pass on retry = flaky (log warning, add to FACTORY_TRAPS, continue). Fail on retry = real failure (revert Build commit, mark BLOCKED).
- Never commit through a lucky gate pass.

### Defense 3: Prevention Rule Instability

- New rules must pass (`exit 0`) on current code before activation. Otherwise advisory-only in FACTORY_TRAPS.
- Rule removed+regenerated >1x in 10 cycles → block auto-generation for that category.
- Removal cooldown: 3 cycles before removed rule's category can spawn new one.
- >3 rules generated or >2 removed in one cycle → pause Self-Opt.

### Defense 4: Oscillation (feature shipped, removed, re-added)

- Same file reverted >1x in 5 cycles → flag and halt builds on that area.
- Fixed finding reappears in same category within 3 cycles → escalate as architectural issue.

### Defense 5: Architectural Blindness (easy items polished, hard ones ignored)

- Every 5 cycles, 1 Build slot reserved for highest-effort item.
- P0 pending >5 cycles → auto-BLOCKED with "complexity timeout — decompose."
- Items estimated >3 cycles must be decomposed before building.

### Defense 6: Metric Gaming (trivial tests, removed flaky tests)

- Review checks new tests for assertion presence. Zero-assertion tests are findings.
- Simplicity Criterion scoped: applies to structural code, never to defensive error handling.

### Defense 7: State Corruption (crash mid-write, concurrent orchestrators)

- Same-directory temp files for atomic writes (Windows cross-drive safety).
- Lock file with `{ flag: 'wx' }` exclusive create. Renewed implicitly by cycle activity.
- Stale locks auto-expire after 30 minutes.
- Cycle ID in state file headers detects unauthorized modifications.

### Defense 8: External Interference (human/CI modifies branch)

- SHA reachability check at cycle start: `git rev-parse` previous SHA. Orphaned → halt.
- Dirty tree detection: unexpected changes → stash and log.

### Defense 9: Unbounded Growth (state files exceed context budget)

- Queue indexes: max 20 lines. Keep last 50 cycle files. Archive older.
- FACTORY_METRICS.md: keep last 15 rows.
- Self-Opt manages archival every 5th cycle.

### Defense 10: Simplicity Criterion Misapplied to Production Safety

- Simplicity applies to factory process, NOT production safety code.
- Error guard removal requires production data confirming impossibility.
- The 2am test: "Would a senior engineer on-call at 2am be grateful this guard exists?" If yes, keep it.

### Defense 11: Concurrent Cycles

- Dual cron + lock file. Lock checked at cycle start.
- Stale locks auto-expire after 30 minutes.
- One-shot cron ensures only one completion check per cycle.

### Defense 12: Zombie Processes

- Pre-cycle cleanup sweep (`cleanup-resources.js`) kills orphaned processes on ports >11000.
- Sweeps stale temp directories.
- Never touches anything on port 7777 or below 11000.

### Defense 13: Context Window Exhaustion

- Dual cron with fresh prompts per fire. Each cycle reads from files, not conversation history.
- Managers use targeted file reading (line ranges, grep), never whole large files.
- Orchestrator stays thin (~10K tokens per cycle).

### Defense 14: Bad Commits

- Build-on-branch pattern. Work branch per item. E2E against work branch.
- Only merge to {working_branch} on pass. Failed branches deleted, items re-queued.

### Defense 15: Safety Code Removal

- R15 (safety code is not complexity). Build Manager safety blacklist.
- Review Manager adversarial prompt flags removal of safety code as Critical.
- Security-Immutable Rules (SI-1 through SI-6) enforce specific safety boundaries.

### Defense 16: Systemic Process Failure

- SYSTEMIC_BLOCK mechanism. Any team can propose a block.
- Orchestrator validates and activates. Halts Build/Simulate.
- Max 3 active blocks (prevent block spam).
- Block active 5+ cycles without resolution → escalate to human or auto-terminate.

### Defense 17: Advisory Drift

- Advisory outputs (CPO, Oversight, Factory-Opt) are recommendations only.
- Orchestrator sanity check: no advisory reorders more than 3 queue items per cycle.
- Conflicting advisory recommendations across 2+ cycles: log conflict, defer to most recent.


---

## 22. Immutable Properties

These can NEVER be changed by any team, pipeline, or self-improvement loop. They are the factory's constitution.

1. **Tests only go up** — No cycle may reduce test count
2. **Quality gate before merge** — The monotonic ratchet is inviolable
3. **Quality gate composition is immutable** — `npm test` + `npm audit` + prevention checks set in project contract
4. **Orchestrator is sole state writer** — R1 is absolute
5. **One item per Build cycle** — R7 prevents scope explosion
6. **Review runs when new commits exist** — The adversarial immune system activates on every code change. If HEAD matches previously reviewed SHA, Review is skipped.
7. **Max 3 review iterations per finding** — Prevents infinite loops
8. **Error handlers are not "unnecessary complexity"** — Defensive code preserved
9. **Port safety is inviolable** — Port 7777 and ports <11000 NEVER touched
10. **No AI attribution** — Enforced by `check-no-attribution.js` prevention check
11. **Security-Immutable Rules (SI-1 through SI-6) cannot be weakened** — By ANY team including CPO and Factory Optimization
12. **The factory never asks for permission** — R16 is absolute. Autonomy is a design constraint, not a preference.
13. **Quality over cost** — R12 is absolute. Never reduce thoroughness to save tokens. Caps are safety rails, not budget targets.
14. **SYSTEMIC_BLOCK halts Build/Simulate** — A block is not advisory; it is a hard halt.
15. **E2E gate is non-bypassable when spec files exist** — R13 is absolute. Cannot be weakened by any team.
16. **`fullyParallel: false` in Playwright config is load-bearing** — Each test file creates a server in `beforeAll`. Setting `fullyParallel: true` causes 3x redundant server instances, exhausting resources. No factory team may change this setting.


---

## 23. Operational Lessons

These lessons were learned from prior factory runs and project-specific debugging. They are not theoretical — each one caused real failures or wasted cycles.

### OL-1: Large file reading trap

`server.js` is ~99KB (~2750 lines), `app.js` is ~216KB (~4870 lines). Managers must NEVER read these files whole. Always use line ranges or grep. Including even one of these in a manager brief can consume 20-30% of the context window, leaving insufficient room for reasoning.

**For all managers**: When the item scope includes server.js or app.js, the brief MUST specify exact line ranges. "Read server.js" is never acceptable.

### OL-2: WebSocket test isolation

With `--workers=2`, tests must not share ports, temp files, or server instances. Use `port: 0` (OS-assigned, typically 49152+) and unique temp directories per worker. The `check-port-safety.js` prevention check catches hardcoded ports but not shared global state.

**Root cause**: E2E tests create servers in `beforeAll`. With `fullyParallel: false` (CRITICAL setting), each test FILE gets its own server. With `fullyParallel: true`, each test CASE creates redundant servers, exhausting ports and memory.

### OL-3: ConPTY buffer management

Node-pty on Windows with ConPTY has a ~16KB kernel buffer. The project uses:
- Chunk size: 4,096 bytes (safely below the limit)
- Inter-chunk delay: 10ms (allows buffer to drain)
- TERM: `xterm-256color`, COLORTERM: `truecolor`

**Trap**: ConPTY exit codes are objects (`{ exitCode: N }`), not numbers. Any code comparing `exitCode === 0` must handle both forms.

### OL-4: Prevention check false positive spiral

Self-Opt can create overly broad prevention rules that flag legitimate code. When a prevention check's false positive rate exceeds 20%, it must be removed immediately — not refined. Refinement attempts typically add complexity without reducing false positives.

**Protocol**: Remove → 3-cycle cooldown → regenerate with narrower pattern. Never iterate in-place.

### OL-5: Windows path separators in git

Git on Windows outputs forward slashes in file paths, but `path.join()` produces backslashes. When comparing git diff output to filesystem paths, normalize separators first. This affects `check-docs-sync.js` and any check matching git output against file paths.

### OL-6: Port safety enforcement depth

Port safety has 5 enforcement layers:
1. `check-port-safety.js` — scans staged files for hardcoded ports <11000
2. `cleanup-resources.js` — kills only processes on ports >11000
3. Manager briefs — every Build brief includes the port safety rule
4. FACTORY_TRAPS.md — documents the constraint
5. Test infrastructure — `createServer()` uses `port: 0` (OS-assigned)

All 5 must agree. A single weak layer will eventually be exploited by coincidence.

### OL-7: Spec-code contract enforcement

`check-docs-sync.js` maps 17 source files to spec files. When source changes but spec doesn't, the check fails. This catches most desync but not structural changes (new modules without corresponding new specs). Discovery should flag missing specs as work items.

### OL-8: E2E rotation timing

Full suite (cycle mod 5 == 4) takes 4-6 minutes with `--workers=2`. Subset rotations take 1-3 minutes. Plan cycle timing accordingly — the dynamic one-shot cron should account for whether this is a full-suite or subset cycle.

### OL-9: CPO memos don't change behavior — rules do

If a CPO memo identifies a problem and the problem persists next cycle, the memo failed. Convert the observation to a protocol RULE or SYSTEMIC_BLOCK. Work items can be deprioritized; rules cannot. Memos are awareness; rules are enforcement.

### OL-10: Orchestrator must verify, not just collect

Don't trust team verdicts blindly. When QA says PASS, verify the evidence:
1. Were E2E spec files found? (`spec_files_found` populated)
2. Did E2E actually run? (`ran == true`, `count > 0`)
3. A PASS verdict with no E2E execution when spec files exist is a FAIL.

### OL-11: `fullyParallel: false` is load-bearing

The Playwright config sets `fullyParallel: false`. This is CRITICAL. Each test file creates a server in `beforeAll`. Setting `fullyParallel: true` would create 3x redundant servers per file, exhausting CI resources. This setting must never be changed by any factory team.

### OL-12: `isAvailable()` sync fallback blocks

`base-bridge.js` had a sync `execFileSync` fallback that blocked 5 seconds per missing tool (20s on CI with 4 bridges). Fixed with async cache pre-population. If bridge availability checks regress to sync, test startup will be extremely slow.

### OL-13: File browser z-index and keyboard traps

The file browser panel had 9 documented bugs (see `docs/history/file-browser-bugs.md`): z-index conflicts with other panels, missing tabindex for keyboard focus, Escape key double-firing, CSS/JS class naming mismatches, and document-level event listener gaps. When building UI panels, always: add document-level keyboard listeners for global shortcuts, coordinate CSS and JS class names upfront, and test keyboard navigation explicitly.

### OL-14: Canvas atlas invalidation on font load

xterm.js caches glyph bitmaps in a canvas texture atlas. When loading custom fonts (Nerd Fonts), calling `terminal.refresh()` alone is insufficient — the stale atlas causes tofu rendering. Must call `clearTextureAtlas()` before `refresh()` on font load events (see `docs/history/nerd-font-tofu-rendering.md`).

### OL-15: WebSocket race conditions in E2E image paste tests

Image paste tests had flaky failures due to asserting on async WebSocket messages synchronously. The fix: start `collectMessages()` BEFORE sending input, then assert on collected results. Never assert on async WebSocket messages without a polling helper with timeout (see `docs/history/flaky-image-paste-test.md`).

### OL-16: npm tarball hygiene — .npmignore completeness

npm arborist dedup bug triggered by dev artifact leakage into the published tarball. Every new directory must have an `.npmignore` entry. Monitor tarball size (`npm pack --dry-run`) to catch bloat early (see `docs/history/npm-latest-tarball-bug.md`).

### OL-17: marked.js does NOT sanitize — pair with DOMPurify

The plan viewer and feedback system use `marked.js` for markdown rendering. `marked()` does NOT sanitize HTML — XSS is possible via crafted markdown. Always pair with DOMPurify or equivalent sanitizer (see `docs/history/ux-feedback-overlay-planviewer.md`).

### OL-18: Mobile UX deferred risks

10 deliberate mobile UX deferrals documented in `docs/history/mobile-ux-overhaul-deferrals.md`: ResizeObserver re-entry loops, VirtualKeyboard API detection, GBoard composition handling, custom key bar complexity. When working on mobile features, check this file first — these are known minefields.


---

## 24. Autoresearch Patterns (from Karpathy)

[Andrej Karpathy's Autoresearch](https://github.com/karpathy/autoresearch) is a 630-line autonomous ML experiment runner. ~700 code modifications in 2 days, ~20 stacking improvements, 11% training speedup on already-optimized code. These are the transferable patterns.

### Pattern 1: The Monotonic Ratchet

Autoresearch creates monotonic git history — the branch only advances when the metric improves. Failed experiments revert via `git reset HEAD~1`. Results.tsv logs ALL attempts (kept, discarded, crashed), but git only shows winners.

**Applied**: The Build Team runs the quality gate BEFORE committing. If the gate fails, code is reverted, not committed-then-fixed. The build-on-branch pattern ensures only passing builds reach `{working_branch}`.

### Pattern 2: The Simplicity Criterion

From `program.md`: "0.001 improvement from deleting code? Keep. Zero improvement but simpler? Keep. 0.001 improvement from 20 lines of hacks? Discard."

**Applied**: Every Build Team brief includes: "Prefer removing complexity over adding it. A simpler solution that meets acceptance criteria is preferred over a sophisticated one." The Factory Optimization Team enforces this at the factory level — removing unused state files, stale traps, and boilerplate from briefs.

### Pattern 3: Fixed Time Budget

Every Autoresearch experiment runs for exactly 5 minutes. Crashes or timeouts are automatic failures.

**Applied**: Each team gets a timeout ceiling (Build: 15m, Review: 10m, Discovery: 10m, QA: 10m, CPO: 10m). Exceeding = automatic PARTIAL report. The item returns to the queue.

### Pattern 4: Immutable Evaluation

Autoresearch's evaluation pipeline is immutable. The agent can only modify training code.

**Applied**: The quality gate (`npm test` + `npm audit` + prevention checks) is defined in the project contract and immutable to the Build Team. Only Factory Optimization can add checks — never weaken existing ones.

### Pattern 5: Single Mutable Surface

Autoresearch restricts changes to one file. This keeps diffs reviewable.

**Applied**: One item per Build cycle (R7). Build briefs specify expected file count. If significantly more files needed, report PARTIAL and request split.

### Pattern 6: Dual Logging (Attempts vs. Successes)

Autoresearch tracks `results.tsv` (everything tried) alongside git (only kept).

**Applied**: Cycle files track outcomes. `attempts.jsonl` tracks every Build attempt including failures and diagnostics. Discovery reads attempts to avoid repeating failed approaches.

### Pattern 7: "Never Stop" Directive

From `program.md`: "Do NOT pause to ask the human."

**Applied**: The factory's default is to keep running (R16). It evaluates convergence criteria and either continues or terminates. The only human input is the initial vision and occasional intervention.

### Pattern 8: Progress-Based Scheduling

Autoresearch's schedules depend on `progress = training_time / TIME_BUDGET`.

**Applied**: The factory adapts its cycle composition:
- **Early cycles (0-30%)**: Heavy Discovery + Build (exploring, scaffolding)
- **Middle cycles (30-70%)**: Heavy Build + Review (shipping, quality)
- **Late cycles (70-100%)**: Heavy Review + Self-Opt + Process Improvement (polishing, converging)

### Patterns NOT Adopted (and why)

- **Single metric optimization**: Software has multiple quality dimensions. Multi-gate approach (ALL must pass) is more appropriate.
- **No adversarial review**: Autoresearch validates only via metric. Software needs adversarial review for security, accessibility, architecture.
- **Commit-then-revert order**: Autoresearch commits before running, reverts on failure. The factory gates before committing — both achieve monotonic history.

---

## 25. Why This Factory Works

1. **The Compounding Effect** — Prevention rules reduce bugs. Fewer bugs mean faster cycles. Faster cycles mean more iterations. More iterations mean more features AND more patterns for prevention rules. The improvement is exponential, not linear.

2. **Adversarial Quality as Immune System** — The Review Team does not confirm quality — it attacks it. Four expert agents each try to break the code from their domain lens. Builder-reviewer separation prevents confirmation bias.

3. **Common Pipeline as Single Source of Truth** — One pipeline, one priority order. Critical findings outrank new features. QA failures outrank polish. The Build Team pulls the most important item, always.

4. **Diverse Expert Viewpoints** — Each team has agents with fundamentally different lenses. A Security Reviewer thinks "how would an attacker exploit this?" while a Performance Reviewer thinks "what happens at 10x load?" These viewpoints don't overlap — each catches problems the others are blind to.

5. **Stateless Recovery** — Everything is in files. Crash recovery is trivial: read state files, check git, resume. No in-memory state is required. No "where was I?" problem.

6. **CPO as Strategic Rudder** — Without CPO, the factory optimizes locally (fix easy bugs, ship simple features). With CPO, it optimizes globally (build what matters for the vision, defer what doesn't serve users).

7. **Factory Optimization as Meta-Learning** — Doesn't build software — learns HOW to build software better. Pattern analysis generates prevention rules. Prevention rules reduce future bugs. The factory improves its own learning process.

8. **Thin Orchestrator Longevity** — The orchestrator reads <10K tokens per cycle and never reads source code. It can run indefinitely without context exhaustion. Teams do the heavy lifting.

9. **Autonomous Until Done** — Runs until ALL teams run out of work and unanimously agree. No arbitrary deadline. A mature codebase might terminate after 5 cycles. A greenfield project might run 100+. The factory adapts to actual work.

10. **Local-First Everything** — Full control over testing, verification, and validation. No external CI dependency during factory operation. Fast iteration. CI is the final gate at merge time, not the development loop.

11. **Build-on-Branch Safety** — Bad commits never reach the working branch. Work happens on `factory/wip-{item}` branches. E2E runs against the work branch. Only merge on pass. Failed branches are deleted. Rollback is trivial.

12. **Port Safety as Defense in Depth** — 5 enforcement layers (prevention check, cleanup sweep, manager briefs, FACTORY_TRAPS, test infrastructure defaults). No single point of failure. Port 7777 is untouchable.

13. **Windows-Aware State Management** — Per-cycle JSON files (no JSONL append races). Same-directory atomic renames (no cross-drive failures). Exclusive lock creation. Path separator normalization. The factory runs correctly on both Windows and Linux.

14. **Dual Cron Reliability** — Heartbeat every 12 minutes catches stalls and early completions. Dynamic one-shot catches expected completions immediately. Together: fast cycle transitions + crash recovery. The factory never stalls silently.

