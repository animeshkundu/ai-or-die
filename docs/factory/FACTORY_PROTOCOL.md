# The Autonomous Factory Protocol — ai-or-die

A self-improving software factory adapted for the ai-or-die project. Runs entirely locally. Discovers what to build, builds it, reviews its own work adversarially, learns from its mistakes, improves its own process, and stops only when converged.

---

## 1. Philosophy

The factory is a **self-improving autonomous system** that:

1. **Discovers** what needs to be built (gaps, quality issues, missing features)
2. **Builds** it, one atomic improvement at a time
3. **Reviews** its own work adversarially (separate agent, no design rationale)
4. **Learns** from patterns in its own mistakes (prevention rules)
5. **Improves its own process** (not just the product)
6. **Stops** only when both the product and the process have converged

**Core invariant**: Every cycle leaves BOTH the codebase AND the factory in a better state. Tests only go up. Quality only improves. Process friction only decreases. If a cycle can't improve either, the factory terminates.

**The Ratchet Principle**: The branch only advances on verified improvement. Failed attempts are reverted, not committed-then-fixed. The factory's trajectory is strictly non-decreasing in quality.

**The Simplicity Criterion**: Prefer removing complexity over adding it. A simpler codebase with the same functionality is an improvement. **Critical exception**: The Simplicity Criterion applies to factory process only — NEVER to production error handlers, catch blocks, validation code, or defensive checks. The 2am test: "Would a senior engineer on-call at 2am be grateful this code exists?" If yes, keep it.

**Local-first**: All testing, verification, and validation runs on the local machine. No dependency on GitHub Actions or external CI. The factory has full control over every aspect of the development loop.

**No attribution**: The factory's output reads as human-authored. No Co-Authored-By trailers, no "Generated with" markers, no AI references anywhere — commits, PRs, issues, code, docs.

---

## 2. Project Contract

```
Project:     ai-or-die (Claude Code Web)
Language:    Node.js 22+ (CommonJS modules)
Framework:   Express.js + WebSocket (ws) + xterm.js
Description: Web-based multi-tool AI interface (Claude, Copilot, Gemini, Codex)

Build:       N/A (interpreted Node.js — no build step for dev)
Test (unit): npm test
Test (E2E):  npx playwright test --config e2e/playwright.config.js --workers=2
Audit:       npm audit --audit-level=high
Binary:      node scripts/build-sea.js (for release only)

Default port: 7777 (PROTECTED — never touch)
Test ports:   >11000 only (enforced by check-port-safety.js)

Branch:      factory/autonomous (working branch)
Base:        main (merge target)
```

### Quality Gate (must pass before every commit)

1. `npm test` passes (unit test count must not decrease)
2. E2E subset passes (rotation schedule, `--workers=2`)
3. `npm audit --audit-level=high` passes
4. Prevention checks pass (`docs/factory/checks/run-checks.js --stage build`)
5. No AI attribution markers in staged files
6. Spec-code contract maintained (source changes have corresponding spec updates)

### Constraints

- Cross-platform: all code must work on Windows and Linux (`path.join()`, dual script variants)
- Port safety: all test ports >11000, never interfere with port 7777 or any port <11000
- Performance: any inner-loop step >5 minutes must be parallelized (8+ cores available)
- Conventional Commits format for all commit messages
- ADR compliance: never contradict an accepted ADR
- Spec updates: code behavior changes require corresponding `docs/specs/` updates

### North Star

A browser-based multi-tool AI interface that provides seamless, real-time terminal access to Claude, Copilot, Gemini, and Codex — with multi-session support, cross-platform deployment, voice input, file browsing, and mobile-responsive design. Publishable quality that ships to npm and runs as a standalone binary.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────┐
│                    ORCHESTRATOR                       │
│  Reads state files (~3-5K tokens). Never reads code. │
│  Dispatches managers. Writes reports. Chains crons.   │
│  Sole writer of state files (Rule R1).                │
└────────┬───────────┬───────────┬─────────────────────┘
         │           │           │
    ┌────▼────┐ ┌────▼────┐ ┌───▼─────┐
    │Discovery│ │ Review  │ │Self-Opt │  ← parallel (independent)
    └─────────┘ └─────────┘ └─────────┘
         │
    ┌────▼──────────────────┐
    │  Build (+ Verify)     │  ← sequential chain
    └────┬──────────────────┘
    ┌────▼──────────────────┐
    │  Simulate (E2E subset)│  ← lightweight shell cmd
    └───────────────────────┘
```

**Key architectural choices:**

1. **Self-chaining crons** — each cycle schedules the next via one-shot CronCreate. No recurring crons. Guarantees sequential execution. If a cycle crashes, the factory halts safely (no next cron scheduled).

2. **Build-on-branch** — Build Manager works on `factory/wip-{item-id}`. Only after all gates pass does the orchestrator merge into `factory/autonomous`. Failed branches are deleted and items re-queued.

3. **Merged Verify into Build** — Build Manager runs quality gate as part of its workflow. No separate Verify agent. Saves one agent invocation per cycle.

4. **Lightweight Simulate** — E2E runs via shell command (`npx playwright test`), not a full agent. Orchestrator runs it directly via Bash tool.

5. **State files as coordination layer** — all state in `docs/factory/state/`. No in-memory state. Crash-recoverable. Orchestrator is sole writer.

6. **Stateless managers** — every manager is a fresh agent. All context comes from the brief. No cross-cycle memory.

---

## 4. Bootstrap: Cycle 0

Before the factory runs its first real cycle, it must understand the project.

### Step 1: Recon

The orchestrator spawns a single **Recon Agent** (Explore subagent) to discover:

1. Current test count (`npm test` output)
2. Current state of the codebase (what works, what's recent)
3. Open issues, TODOs, spec gaps
4. Known traps from `docs/history/`
5. Existing documentation coverage

The Recon Agent reads: CLAUDE.md, package.json, README, docs/specs/, docs/adrs/, docs/history/, recent git log. It does NOT modify anything.

### Step 2: State Initialization

The orchestrator populates `FACTORY_STATE.json` with:
- `testCountBaseline`: from Recon Agent's `npm test` output
- `startedAt`: current timestamp
- `currentCycle`: 0
- `phase`: "running"

### Step 3: First Dispatch

Cycle 0 dispatches two managers in parallel:
1. **Discovery Manager** — gap analysis against specs, docs, north star
2. **Review Manager** — baseline quality scan of recent changes

After both complete, the orchestrator populates queues and begins the main loop.

---

## 5. The Main Loop

Every cycle follows the same flow. The orchestrator never deviates.

### 5.1 READ (~10 seconds)

Read state files only (small — <5K tokens total):
- `docs/factory/state/FACTORY_STATE.json` — current cycle, cost, convergence counters
- `docs/factory/state/WORK_QUEUE.md` — what needs building
- `docs/factory/state/REVIEW_QUEUE.md` — what needs fixing
- `docs/factory/state/VERIFY_STATUS.md` — did last build pass?
- `docs/factory/state/FACTORY_METRICS.md` — trends
- Last cycle file from `docs/factory/state/cycles/` — what happened last cycle

### 5.2 DECIDE (~10 seconds)

Apply the decision table:

| Condition | Pipeline | Priority |
|-----------|----------|----------|
| Always (if diff since last review is non-empty) | Review | 1 (highest) |
| Work queue or review queue has items | Build | 2 |
| Build committed new code | Simulate (E2E subset) | 3 |
| Cycle % 3 == 0 OR both queues empty | Discovery | 4 |
| Cycle % 5 == 0 | Self-Optimization | 5 |

**Cap: max 3 managers per cycle** (cost control — reduced from 4 to save tokens).

**Skip rules:**
- Skip Review if `git diff` since last reviewed SHA is empty (no code changes)
- Skip Discovery if `(NEW + IN_PROGRESS) > 10` in work queue (queue cap)
- Skip Discovery if queue depth > 15 (hard halt Discovery)
- Skip Build if all remaining items are BLOCKED for 2+ consecutive cycles

### 5.3 DISPATCH

Spawn managers as fresh Agent tool calls with self-contained briefs.

**Parallel group**: Review + Discovery + Self-Opt (if eligible, all independent)
**Sequential**: Build (after parallel group completes) → Simulate (after Build, if Build committed)

### 5.4 COLLECT

Each manager returns a structured report:

```
Status: SUCCESS | PARTIAL | FAILED | BLOCKED
Summary: One-line description
Items Completed: [list of IDs]
Items Added: [new items with priority and severity]
Files Changed: N
Tests Before: N
Tests After: N
Commits Made: [list of SHAs with messages]
Blockers: [anything preventing progress]
```

### 5.5 WRITE (~10 seconds)

Orchestrator updates ALL state files:
- Queue indexes (add new items, update statuses)
- `VERIFY_STATUS.md` (gate results)
- `FINDING_HISTORY.md` (category counts)
- `FACTORY_METRICS.md` (per-cycle row, including estimated cost)
- Per-cycle log file (`docs/factory/state/cycles/cycle-NNN.json`)
- `FACTORY_STATE.json` (cycle number, cumulative cost, convergence counters)

### 5.6 CHAIN NEXT

Schedule the next cycle via one-shot cron:

```
CronCreate({
  cron: "<next minute> <current hour> <today> <this month> *",
  prompt: "<self-contained cycle prompt — see Section 7>",
  recurring: false
})
```

The prompt is fully self-contained — it reads all context from state files. This prevents context window exhaustion.

### 5.7 EVALUATE TERMINATION

Check stopping criteria (Section 15). If met, enter termination gate. Otherwise, the chained cron fires and the loop continues.

---

## 6. The Pipelines

### Pipeline 1: Discovery

**Purpose**: Find what to build next.
**Agent mapping**: Researcher agent persona.
**Frequency**: Every 3rd cycle, or when queues are empty. Skipped if queue depth > 10.

**Process**:
1. Read: CLAUDE.md, relevant docs/specs/, docs/adrs/, docs/history/
2. Read: FACTORY_TRAPS.md, deferred items, attempts.jsonl (last 20 entries)
3. Compare current state against north star / specs
4. Identify gaps, missing features, quality improvements
5. Prioritize: P0 (blocks core workflow), P1 (significant improvement), P2 (polish)

**Output**: 3-5 work items as `docs/factory/state/queue-details/WI-{N}.md`, each with:
- Why now (persona + friction point)
- Acceptance criteria (testable checklist, 3-8 items)
- Scope (files to create/modify — specify line ranges for large files)
- Estimated cycles (1-2)
- Dependencies and risks

**Cost control**: Discovery uses Glob/Grep for codebase survey, never reads entire large files. Max 3-5 items (not 3-8 as in raw protocol).

### Pipeline 2: Continuous Review

**Purpose**: Find quality issues in recent changes.
**Agent mapping**: QA Reviewer agent persona.
**Frequency**: Every cycle (if diff is non-empty).

**Process**:
1. `git diff {prev_sha}..{frozen_sha}` — review only the diff, not full files
2. Scan for: security vulns, cross-platform issues, dead code, pattern violations
3. Check against `FACTORY_TRAPS.md` patterns
4. Rate: Critical / Important / Suggestion
5. Only HIGH CONFIDENCE findings (exact file:line + reproduction + fix)

**Output**: Findings as `docs/factory/state/queue-details/RQ-{N}.md`.

**Critical rules**:
- Review operates on a FROZEN SHA (captured before dispatch)
- Reviewer receives diff + intent only — NEVER the design rationale (adversarial isolation)
- Flag any removal of error handling or validation as Critical

### Pipeline 3: Build (with Integrated Verify)

**Purpose**: Implement the highest-priority item.
**Agent mapping**: Engineer agent persona.
**Frequency**: When queue has items.

**Process**:
1. Create work branch: `git checkout -b factory/wip-{item-id}`
2. Read the item detail from `docs/factory/state/queue-details/{ID}.md`
3. Read ONLY the targeted source sections specified in the item (not whole files)
4. Read FACTORY_TRAPS.md for relevant patterns
5. Implement the item
6. Run quality gate (all in parallel where possible):
   - `npm test` — count must not decrease
   - `npm audit --audit-level=high` — must pass
   - Prevention checks (`node docs/factory/checks/run-checks.js --stage build`)
7. If gate passes: commit with Conventional Commits message referencing item ID
8. If gate fails: 2 attempts to fix. After 2 failures: report BLOCKED, delete work branch

**Output**: Files changed, tests before/after, commit SHAs, branch name.

**Scope rule**: One item per build. If estimated >2 cycles, split before implementing.

**Safety blacklist** (included in every Build Manager brief):
- Never remove try-catch blocks, error handlers, or validation code
- Never remove defensive checks or timeout guards
- Never hardcode ports below 11000
- Always use path.join() for file paths
- Always update docs/specs/ when behavior changes

### Pipeline 4: Simulate (E2E Subset)

**Purpose**: End-to-end validation.
**Implementation**: Shell command run by orchestrator (not a full agent).
**Frequency**: After Build commits code.

**Process**:
1. Determine E2E rotation (see Section 18)
2. Run cleanup sweep: `node docs/factory/checks/cleanup-resources.js`
3. Run: `npx playwright test --config e2e/playwright.config.js --workers=2 --project=<rotation>`
4. Parse results: pass count, fail count, failure details

**On failure**: Delete the work branch (`git branch -D factory/wip-{item-id}`). Re-queue item with failure notes. Do NOT merge into factory/autonomous.

**On success**: Fast-forward merge: `git checkout factory/autonomous && git merge factory/wip-{item-id} && git branch -d factory/wip-{item-id}`

### Pipeline 5: Self-Optimization

**Purpose**: Learn from patterns, generate prevention rules.
**Frequency**: Every 5th cycle.

**Process**:
1. Read FINDING_HISTORY.md — categories with 3+ occurrences
2. Generate prevention check scripts for recurring categories
3. Validate: run new rules against current code, reject if >20% false positives
4. Update FACTORY_TRAPS.md with new patterns (2+ occurrences)
5. Remove rules with >20% false positives across 3+ cycles

**Output**: Rules generated/removed, patterns added. Written to `docs/factory/checks/`.

**Constraint**: Self-Opt NEVER modifies CLAUDE.md, AGENTS.md, or any existing docs/ content. Only factory-specific files.

### Pipeline 6: Process Improvement

**Purpose**: Make the factory itself better.
**Frequency**: Every 5th cycle (alternating with or combined with Self-Opt).

**Process**:
1. Analyze factory metrics: build pass rate, items/cycle, waste ratio
2. Identify bottlenecks: which steps are slowest? Which items get BLOCKED?
3. Write proposals to `docs/factory/state/factory-proposals.md`
4. Adjust scheduling parameters within bounds (queue cap, Discovery frequency)

**Output**: Proposals (human-reviewable), parameter adjustments.

**Constraint**: Process Improvement writes proposals, not live protocol changes. Within a single run, only parameter adjustments (scheduling frequency, queue caps) apply immediately, within pre-defined bounds.

---

## 7. Cron Orchestration

### Self-Chaining Pattern

The factory uses one-shot crons (`recurring: false`) that self-chain. This prevents:
- Concurrent cycles (race conditions on state files)
- Context window exhaustion (each prompt is fresh)
- Runaway costs (crash = halt, no zombie crons)

### Cycle Prompt Template

The cron fires this prompt (the orchestrator executes it):

```
FACTORY CYCLE — Read docs/factory/state/FACTORY_STATE.json for cycle number and status.

INSTRUCTIONS:
1. Acquire lock: check docs/factory/state/.factory-lock — if it exists and is <30 min old, exit immediately
2. Create lock file with current timestamp
3. Read all state files (WORK_QUEUE, REVIEW_QUEUE, VERIFY_STATUS, FACTORY_METRICS, last cycle file)
4. Check termination: if cycleCapRemaining <= 0 OR cumulativeCost >= costCeiling OR consecutiveIdleCycles >= 5, terminate
5. Apply decision table (Section 5.2) to determine which pipelines to run
6. Run cleanup sweep: node docs/factory/checks/cleanup-resources.js
7. Capture frozen SHA: git rev-parse HEAD
8. Dispatch managers (parallel group, then sequential chain)
9. Collect reports, update all state files
10. Release lock (delete .factory-lock)
11. Schedule next cycle: CronCreate with recurring=false, fires in 60 seconds
12. If convergence detected (Section 15), enter termination gate instead of scheduling next cycle

PORT SAFETY: Never touch port 7777 or any port below 11000. All test ports >11000.
ATTRIBUTION: No AI markers in any output — commits, code, docs.
COST: Track estimated cost. Hard cap at 30 cycles, $50 total.
```

### Lock File Protocol

```
docs/factory/state/.factory-lock
```

Contents: JSON with `{ "cycle": N, "timestamp": "ISO-8601", "pid": process.pid }`

- Created at cycle start with `fs.writeFileSync` using `{ flag: 'wx' }` (exclusive create)
- Deleted at cycle end
- If lock exists and timestamp < 30 minutes old: skip this cycle (another is running)
- If lock exists and timestamp > 30 minutes old: stale lock, delete and proceed (previous cycle crashed)

### Bootstrapping the First Cron

To start the factory, the user runs:

```
/factory start
```

Or the orchestrator creates the first cron:

```javascript
CronCreate({
  cron: "<1 minute from now>",
  prompt: "<cycle prompt template>",
  recurring: false
})
```

---

## 8. Local Quality Gate

All quality gates run locally. No CI dependency.

### Gate Composition

```
┌─────────────────────────────────────────────┐
│              LOCAL QUALITY GATE              │
│                                             │
│  ┌─────────────┐ ┌──────────────┐          │
│  │  npm test   │ │  npm audit   │  parallel │
│  │  (unit)     │ │  (security)  │          │
│  └─────────────┘ └──────────────┘          │
│  ┌─────────────┐ ┌──────────────┐          │
│  │ prevention  │ │  attribution │  parallel │
│  │  checks     │ │  scan        │          │
│  └─────────────┘ └──────────────┘          │
│                                             │
│  All must pass → commit                     │
│                                             │
│  ┌──────────────────────────────┐           │
│  │  Playwright E2E subset      │ sequential│
│  │  --workers=2 --project=...  │ (after    │
│  └──────────────────────────────┘  commit)  │
│                                             │
│  E2E pass → merge to factory/autonomous     │
│  E2E fail → delete work branch, re-queue    │
└─────────────────────────────────────────────┘
```

### Performance Budget

Each gate step must complete within 5 minutes. If exceeded:
- Unit tests: investigate — should complete in <30 seconds
- E2E subset: reduce project count for this rotation
- npm audit: timeout and log warning (non-blocking for low/moderate)
- Prevention checks: run in parallel (already do)

With 8+ cores, the parallel checks (unit + audit + prevention + attribution) should complete in <1 minute. The E2E subset (1-3 projects, workers=2) should complete in 2-4 minutes.

---

## 9. Port Safety Protocol

### Protected Ports

| Port | Owner | Rule |
|------|-------|------|
| 7777 | ai-or-die production | NEVER touch — do not bind, kill, or query processes on this port |
| 1-10999 | System/other apps | NEVER bind test infrastructure to these ports |
| 11000+ | Factory test zone | Safe for test servers, Playwright, ephemeral ports |

### Enforcement Layers

1. **Prevention check** (`check-port-safety.js`): Scans staged test files for hardcoded ports <11000
2. **Cleanup sweep** (`cleanup-resources.js`): Only kills processes on ports >11000
3. **Manager briefs**: Every Build Manager brief includes the port safety rule
4. **FACTORY_TRAPS.md**: TRAP-005 documents the constraint
5. **Test infrastructure**: `createServer()` uses `port: 0` (OS-assigned, typically 49152+). `spawnCli()` uses 49152-65534 range. Both are >11000.

### Port Verification

Before each cycle, the cleanup sweep verifies port 7777 status (informational only — never modifies it).

---

## 10. Resource Cleanup Protocol

Every cycle starts with a cleanup sweep (`node docs/factory/checks/cleanup-resources.js`).

### What Gets Cleaned

1. **Orphaned Node.js processes** on ports >11000 (older than 10 minutes)
   - Windows: `netstat -ano` + `taskkill`
   - Linux: `lsof` + `kill`
2. **Orphaned Chromium processes** (headless, older than 10 minutes)
3. **Stale temp directories** (`ai-or-die-test-*` in os.tmpdir(), older than 5 minutes)
4. **Stale lock files** (`.factory-lock` older than 30 minutes)

### What Is NEVER Cleaned

- Anything on port 7777 or below 11000
- User's browser processes
- Non-test Node.js processes
- Files outside os.tmpdir() and docs/factory/state/

---

## 11. State File Integrity

### Atomic Writes on Windows

**Problem**: `fs.rename()` fails across drives (Q: repo vs C: temp dir). This is a known Windows issue.

**Solution**: All temp files are written in the SAME directory as the target file:

```javascript
const tempPath = targetPath + '.tmp-' + crypto.randomUUID().slice(0, 8);
fs.writeFileSync(tempPath, content);
fs.renameSync(tempPath, targetPath); // Same drive — works on Windows
```

This matches the pattern used by `src/utils/session-store.js` (line 95).

### Per-Cycle Log Files

Instead of appending to a shared `CYCLE_LOG.jsonl` (which has append-race issues), each cycle writes its own file:

```
docs/factory/state/cycles/cycle-001.json
docs/factory/state/cycles/cycle-002.json
...
```

Each file is a complete JSON object:

```json
{
  "cycle": 1,
  "startedAt": "2026-03-22T22:00:00Z",
  "completedAt": "2026-03-22T22:08:00Z",
  "pipelines": ["review", "discovery"],
  "itemsCompleted": [],
  "itemsAdded": ["WI-1", "WI-2"],
  "testsBefore": 420,
  "testsAfter": 420,
  "buildResult": null,
  "e2eResult": null,
  "estimatedCost": 2.50,
  "managers": {
    "review": { "status": "SUCCESS", "findings": 0 },
    "discovery": { "status": "SUCCESS", "itemsCreated": 2 }
  },
  "notes": "Cycle 0 — bootstrap"
}
```

### Serialized Writes

Rule R1 is absolute: the orchestrator is the SOLE writer of state files. Managers create queue-detail files only. This eliminates all concurrent-write issues.

---

## 12. Manager Brief Templates

### Discovery Manager Brief

```
You are the Discovery Manager for Cycle {N}.

PROJECT: Node.js / Express — Web-based multi-tool AI interface
NORTH STAR: Browser-based access to Claude, Copilot, Gemini, Codex with
  real-time streaming, multi-session support, cross-platform deployment.
TEST: npm test  CURRENT TESTS: {N}

Read these files to understand current state:
- CLAUDE.md (project instructions)
- docs/factory/state/FACTORY_TRAPS.md (known patterns)
- docs/factory/state/attempts.jsonl (last 20 entries — avoid repeating failures)

Use Glob and Grep to survey the codebase. DO NOT read entire large files
(server.js is 99KB, app.js is 216KB — use line ranges).

Find 3-5 work items that move this project closer to its north star.
Priority: P0 (blocks core workflow) > P1 (significant improvement) > P2 (polish)

For each item, create docs/factory/state/queue-details/WI-{N}.md with:
- Why now (who benefits, what friction it removes)
- Acceptance criteria (testable checklist, 3-8 items)
- Scope (files to modify — specify line ranges for files >100 lines)
- Estimated cycles (1-2)
- Dependencies and risks

DO NOT write to WORK_QUEUE.md or any other state file.

Return:
  Status: SUCCESS | PARTIAL | BLOCKED
  Summary: {one line}
  Items Created: [WI-N, ...]
  Blockers: {if any}
```

### Review Manager Brief

```
You are the Review Manager for Cycle {N}.

PROJECT: Node.js / Express
FROZEN SHA: {sha}
PREVIOUS SHA: {prev_sha}
KNOWN TRAPS: {list from FACTORY_TRAPS.md}

Review: git diff {prev_sha}..{frozen_sha}

Find problems, not confirm quality. What could break? What assumptions
are wrong? What edge cases are missed?

Scan for:
- Security vulnerabilities (injection, auth bypass, path traversal, XSS)
- Cross-platform issues (path handling, line endings, ConPTY, port hardcoding)
- Dead code (unused imports, unreachable branches)
- Pattern violations from FACTORY_TRAPS.md
- Port safety violations (any port <11000 in test code)
- Missing spec updates (source changed but docs/specs/ not updated)

CRITICAL RULE: Flag ANY removal of error handling, validation, catch blocks,
or defensive checks as a Critical finding. The Simplicity Criterion does NOT
apply to production safety code.

Rules:
- Only HIGH CONFIDENCE findings (exact file:line + reproduction + fix)
- Severity: Critical (blocks) | Important (should fix) | Suggestion
- On severity disagreement, default to higher classification

You do NOT know why the code was written this way. You are given only
the diff and the traps list. Find problems.

Create docs/factory/state/queue-details/RQ-{N}.md per finding.
DO NOT write to REVIEW_QUEUE.md or any other state file.

Return:
  Status: SUCCESS | PARTIAL | BLOCKED
  Summary: {one line}
  Findings: [{id, severity, category, file, line}]
  Blockers: {if any}
```

### Build Manager Brief

```
You are the Build Manager for Cycle {N}.

PROJECT: Node.js / Express
TEST: npm test  AUDIT: npm audit --audit-level=high
CURRENT TESTS: {N} (must not decrease)
KNOWN TRAPS: {list from FACTORY_TRAPS.md}

Your task: Implement {item ID}
Full details: docs/factory/state/queue-details/{item ID}.md

Pre-flight:
1. git checkout -b factory/wip-{item-id} (from factory/autonomous)
2. git status — if dirty, stash with message 'factory-recovery-cycle-{N}'

Read ONLY the files specified in the item scope. For large files (>100 lines),
read only the relevant sections. DO NOT read entire server.js or app.js.

SAFETY BLACKLIST — you must NEVER:
- Remove try-catch blocks, error handlers, or validation code
- Remove defensive checks or timeout guards
- Hardcode ports below 11000
- Use string concatenation for file paths (use path.join())
- Skip spec updates when behavior changes (update docs/specs/)

After implementation, run quality gate (in parallel where possible):
1. npm test — count must be >= {N}
2. npm audit --audit-level=high — must pass
3. node docs/factory/checks/run-checks.js --stage build — must pass

If gate passes: commit with Conventional Commits message referencing {item ID}
If gate fails: 2 attempts to fix. After 2 failures, report BLOCKED.

DO NOT merge into factory/autonomous. DO NOT write state files.
DO NOT push to remote.

Return:
  Status: SUCCESS | PARTIAL | FAILED | BLOCKED
  Summary: {one line}
  Branch: factory/wip-{item-id}
  Files Changed: {N}
  Tests Before: {N}
  Tests After: {N}
  Commits: [{sha, message}]
  Blockers: {if any}
```

### Self-Optimization Manager Brief

```
You are the Self-Optimization Manager for Cycle {N}.

Read:
- docs/factory/state/FINDING_HISTORY.md (categories + counts)
- docs/factory/state/FACTORY_METRICS.md (trends)
- Last 10 cycle files from docs/factory/state/cycles/

Task 1: Prevention rules
- Categories with 3+ occurrences → create docs/factory/checks/check-{name}.js
- Validate: run each rule against current code, reject if >20% false positives

Task 2: Pattern documentation
- Update docs/factory/state/FACTORY_TRAPS.md with new patterns (2+ occurrences)

Task 3: Rule maintenance
- If existing rule has >20% false positives across 3 cycles, remove it

CONSTRAINT: Never modify CLAUDE.md, AGENTS.md, or any docs/ outside factory/.

Log decisions to docs/factory/state/SELF_OPT_LOG.md

Return:
  Status: SUCCESS | PARTIAL
  Summary: {one line}
  Rules Generated: [{name, trigger count}]
  Rules Removed: [{name, reason}]
  Patterns Added: [{id, description}]
```

---

## 13. Cost Tracking

### Per-Cycle Estimation

Each cycle's cost is estimated based on:
- Number of managers spawned (each ≈ $1-5 depending on input size)
- Orchestrator overhead (≈ $0.50 per cycle)
- Typical estimates:
  - Light cycle (Review only): ~$1.50
  - Normal cycle (Review + Build + Simulate): ~$4-6
  - Heavy cycle (Review + Build + Simulate + Discovery): ~$6-10
  - Termination panel: ~$3-5

### Hard Caps

| Cap | Default | Purpose |
|-----|---------|---------|
| Cycle cap | 30 | Prevents runaway cycles |
| Cost ceiling | $50.00 | Prevents unbounded spending |
| Idle cap | 5 consecutive cycles | Prevents no-op spinning |
| Queue cap | 15 items | Prevents unbounded Discovery |

### Auto-Termination Triggers

The factory auto-terminates (without termination panel) if:
1. `cycleCapRemaining <= 0` — used all 30 cycles
2. `cumulativeCost >= costCeiling` — hit $50 ceiling
3. `consecutiveIdleCycles >= 5` — no items completed in 5 cycles
4. All items BLOCKED for 2+ consecutive cycles — no forward progress

On auto-termination, the factory writes a summary to `docs/factory/state/FACTORY_COMPLETE.md` and deletes any pending cron.

---

## 14. Non-Negotiable Rules

### R1: Orchestrator is SOLE writer of state files
Managers NEVER write to queue indexes, metrics, or logs. They return structured reports. Orchestrator serializes all writes.

### R2: Managers are stateless
Every manager is a fresh agent. All context comes from the brief. No cross-cycle memory.

### R3: Tests only go up
Every commit must maintain or increase the test count. If removing tests, add replacements first.

### R4: Build → Simulate is sequential
Build must complete and commit before E2E runs. Build works on a temporary branch.

### R5: Review freezes commit SHA
Before dispatching Review, capture HEAD. Review operates on this frozen SHA.

### R6: Max 3 review iterations per finding
After 3 fix-review cycles on the same finding: defer with rationale. Never loop forever.

### R7: One item per Build cycle
Build implements exactly one item per cycle. Large items must be split first.

### R8: Quality gate before merge
Build Manager commits on work branch. E2E runs against work branch. Only merge to factory/autonomous after E2E passes.

### R9: Prevention rules are earned
Only generate a prevention rule when a finding category hits 3+ occurrences.

### R10: Self-Opt never modifies project files
Auto-generated rules go into `FACTORY_TRAPS.md` and `docs/factory/checks/`. Never touch CLAUDE.md, README, AGENTS.md, or docs/ outside factory/.

### R11: Port safety is inviolable
All test ports >11000. Port 7777 and ports <11000 are NEVER touched. Enforced by prevention check, cleanup sweep, and manager briefs.

### R12: No AI attribution
No Co-Authored-By, "Generated with", or any AI markers. Enforced by prevention check (`check-no-attribution.js`).

### R13: Safety code is not complexity
The Simplicity Criterion applies to factory process only. Production error handlers, catch blocks, validation code, and defensive checks are NEVER "unnecessary complexity." Removing them requires Critical-severity justification.

### R14: Cost ceiling enforced
Factory auto-terminates when cumulative cost reaches ceiling. No exceptions.

### R15: Self-chaining crons only
No recurring crons. Each cycle schedules the next as a one-shot. Crash = safe halt.

---

## 15. Convergence and Termination

### Convergence Criteria

The factory has converged when ALL of these hold simultaneously:
1. Work queue empty for **3 consecutive cycles**
2. Review queue empty for **3 consecutive cycles**
3. Last **full** E2E suite run (all projects) passed with zero failures
4. No BLOCKED items remaining
5. Build pass rate stable (no failures in last 3 cycles)

### The Termination Gate

When convergence is detected, the orchestrator spawns a **3-expert panel** (not 7 — cost-reduced per adversarial review). Each expert is a fresh agent given a summary packet, NOT the full codebase.

### The 3-Expert Panel

| Expert | Focus | "Should NOT stop if..." |
|--------|-------|------------------------|
| **Security Engineer** | Attack surface, auth, injection, secrets | Any input validation gap. Any unmitigated vulnerability. Any secret in code. |
| **Architecture Reviewer** | Coupling, patterns, cross-platform, tech debt | Any architectural smell costing 10x to fix later. Any cross-platform gap. |
| **QA/Testing Specialist** | Test coverage, test quality, flaky tests | Any untested critical path. Any assertion-free test. Any spec-code desync. |

### Expert Input (Summary Packet)

Each expert receives (~30K tokens, not ~706K):
1. `git diff main..factory/autonomous --stat` (summary of all changes)
2. `FACTORY_METRICS.md` (factory performance history)
3. `FACTORY_TRAPS.md` (known patterns)
4. `VERIFY_STATUS.md` (last gate results)
5. CLAUDE.md (project constraints)
6. List of modified files with brief context

They are NOT told that the factory wants to stop. They are told: "Review these changes to the ai-or-die codebase."

### Each Expert Reports

```
Verdict: STOP | DO_NOT_STOP
Confidence: 0-100%
Findings: [specific issues with file:line references]
Missing: [what would need to change for a STOP verdict]
```

### Termination Decision

**Supermajority (2/3) required.** At least 2 of 3 experts must return `STOP` with `Confidence >= 85%`.

- If 2/3 say STOP: Terminate. Document the dissenter's findings as known issues.
- If 1/3 or 0/3 say STOP: Log findings as work items. Resume main loop.
- **Max 2 convocations.** After 2 failed panels, ship with findings documented as known issues.

### After Termination

1. Final full E2E suite run (all projects, not rotation subset)
2. Update all docs (FACTORY_METRICS, VERIFY_STATUS)
3. Write `docs/factory/state/SHIP_REPORT.md`:
   - Expert verdicts and key findings
   - Final metrics (tests, build pass rate, total cycles, estimated cost)
   - Known limitations (deferred items with rationale)
4. Archive cycle files
5. Delete cron (CronDelete)
6. Merge to main via PR (if desired)

---

## 16. Failure Defenses

### Defense 1: Concurrent Cycles
**Mitigation**: Self-chaining one-shot crons + lock file. No recurring crons. Lock checked at cycle start. Stale locks auto-expire after 30 minutes.

### Defense 2: Queue Starvation
**Mitigation**: BLOCKED detection — if all items BLOCKED for 2+ cycles, halt. Queue depth cap at 15. BLOCKED items include a `reason` field.

### Defense 3: Queue Inflation
**Mitigation**: Skip Discovery when queue > 10. Hard cap at 15. Discovery generates 3-5 items (not 3-8). Items estimated >2 cycles must be decomposed.

### Defense 4: Flaky Tests
**Mitigation**: If E2E fails, retry once. Pass on retry = flaky (log warning, add to FACTORY_TRAPS, continue). Fail on retry = real failure (delete work branch, re-queue). Skip unreliable projects (visual regression, perf, voice).

### Defense 5: Zombie Processes
**Mitigation**: Pre-cycle cleanup sweep kills orphaned processes on ports >11000 and sweeps temp dirs. Never touches anything below 11000.

### Defense 6: State Corruption
**Mitigation**: Same-directory temp files (no cross-drive rename). Per-cycle log files (no shared append). Lock file with exclusive create flag. Orchestrator is sole writer.

### Defense 7: Context Window Exhaustion
**Mitigation**: Self-chaining crons with self-contained prompts. Each cycle reads from files, not conversation history. Managers use targeted file reading (line ranges, grep), never whole large files.

### Defense 8: Cost Explosion
**Mitigation**: Hard cycle cap (30). Cost ceiling ($50). Per-cycle estimation in metrics. Idle detection (5 consecutive cycles). Reduced termination panel (3 experts, summaries).

### Defense 9: Bad Commits
**Mitigation**: Build-on-branch pattern. Work branch created per item. E2E runs against work branch. Only merge on pass. Failed branches deleted, items re-queued.

### Defense 10: Safety Code Removal
**Mitigation**: Explicit rule R13. Build Manager blacklist. Review Manager adversarial prompt flags removal of safety code as Critical.

### Defense 11: External Interference
**Mitigation**: SHA reachability check at cycle start. Dirty tree detection → stash and log. If HEAD has moved unexpectedly, halt and investigate.

### Defense 12: Prevention Rule Instability
**Mitigation**: New rules must pass on current code before activation. Rule removed+regenerated >1x in 10 cycles = blocked. Removal cooldown of 3 cycles.

### Defense 13: Oscillation
**Mitigation**: Same file reverted >1x in 5 cycles = halt builds on that area. Fixed finding reappears within 3 cycles = escalate as architectural issue.

### Defense 14: Unbounded State Growth
**Mitigation**: Queue indexes max 20 lines. Keep last 50 cycle files. Archive older to `docs/factory/state/archive/`. Attempts.jsonl: last 100 entries.

---

## 17. Immutable Properties

These can NEVER be changed by any pipeline, manager, or self-improvement loop:

1. **Tests only go up** — no cycle may reduce test count
2. **Quality gate before merge** — the monotonic ratchet is inviolable
3. **Orchestrator is sole state writer** — R1 is absolute
4. **One item per Build cycle** — R7 prevents scope explosion
5. **Review runs every cycle** (when diff is non-empty) — adversarial immune system
6. **Max 3 review iterations per finding** — prevents infinite loops
7. **Error handlers are not "unnecessary complexity"** — defensive code preserved
8. **Port safety is inviolable** — never touch port 7777 or ports <11000
9. **No AI attribution** — enforced by prevention check
10. **Cost ceiling is enforced** — factory auto-terminates on overrun
11. **Self-chaining crons only** — no recurring crons allowed

---

## 18. E2E Test Rotation Schedule

Not all E2E projects run every cycle. This balances thoroughness with speed.

### Rotation (cycle mod 5)

| Cycle mod 5 | Projects | Purpose |
|-------------|----------|---------|
| 0 | golden-path, functional-core | Smoke test — core workflows |
| 1 | functional-extended, new-features | Extended features |
| 2 | mobile-iphone, mobile-pixel, integrations | Mobile + integrations |
| 3 | power-user-flows, ui-features | Power user + UI |
| 4 | **FULL SUITE** (all non-skipped projects) | Comprehensive check |

### Always Skipped in Factory Path

| Project | Reason |
|---------|--------|
| visual-regression | Screenshot baselines drift with OS/font changes — false failures |
| voice-real-pipeline | Requires 670MB model download — environment dependency |

### Special Triggers

- **Before merge to main**: Full suite (all non-skipped projects) — mandatory
- **After Build touches 5+ files**: Full suite in next Simulate step
- **After Build touches security-sensitive code** (auth, rate limiter, path validation): Full suite

---

## 19. Crash Recovery

### On Startup (or after crash)

1. Check for stale lock file (`.factory-lock` > 30 minutes old) — delete if stale
2. Read `FACTORY_STATE.json` — where were we?
3. Read last cycle file from `docs/factory/state/cycles/` — what happened?
4. `git log --oneline -10` — verify state matches reality
5. `git status` — stash if dirty
6. Check for orphaned work branches (`factory/wip-*`) — delete if no useful changes
7. Resume from next cycle number

### State Files as Recovery Source

- All coordination is in files, not memory
- Managers are stateless — re-dispatch with same brief if needed
- Per-cycle log files are atomic (one file per cycle) — no partial-append corruption
- FACTORY_STATE.json is the single source of truth for cycle number and cost

---

## 20. What Makes This Work

1. **State files, not memory.** Everything survives crashes. Managers don't remember anything.
2. **Self-chaining crons.** Sequential execution guaranteed. Crash = safe halt.
3. **Build-on-branch.** Bad commits never reach the factory branch. Rollback is trivial.
4. **Adversarial review as a pipeline.** Quality issues found continuously, not at the end.
5. **Self-optimization.** The factory learns from its mistakes and generates prevention rules.
6. **Cost tracking with hard caps.** No runaway spending.
7. **One item per cycle.** Atomic, reviewable, revertable changes.
8. **Thin orchestrator.** Never reads code. Only reads small state files. Context stays small.
9. **Port safety as inviolable rule.** Protected ports never touched.
10. **Local-first everything.** Full control. No external dependencies. Fast iteration.
