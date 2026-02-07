# Documentation Hygiene

## The Spec-Code Contract

Every component in this codebase has a specification in `docs/specs/`. This is a binding contract:

- If behavior changes, the spec MUST be updated in the same commit. Not the next commit. Not the next PR. The same commit.
- If the spec says X and the code says Y, the code is wrong -- until the spec is deliberately updated.
- Pull requests that change behavior without updating specs are incomplete and should not be merged.

This is not bureaucracy. This is how agents that don't share memory stay in sync. The spec is the source of truth that persists across sessions.

## When to Update What

| You did this | Update this |
|---|---|
| Added a new feature | Write or update spec in `docs/specs/` + write ADR if architectural decision was made |
| Fixed a bug | Update spec if behavior changed + add entry to `docs/history/` with root cause and fix |
| Refactored code | Write ADR if pattern changed + update spec if API surface changed |
| Added a dependency | Write ADR with research findings (version, license, CVE check, alternatives considered) |
| Changed the CI pipeline | Update `docs/agent-instructions/03-tooling-and-pipelines.md` and `06-ci-first-testing.md` |
| Changed WebSocket protocol | Update `docs/architecture/websocket-protocol.md` + update server spec |
| Added a new bridge | Update `docs/specs/bridges.md` + update `docs/architecture/bridge-pattern.md` |
| Changed E2E test structure | Update `docs/specs/e2e-testing.md` + update `06-ci-first-testing.md` CI job map |

When in doubt: update the docs. Over-documentation is always better than under-documentation in an AI-agent-driven codebase.

## ADR Lifecycle

Architecture Decision Records are permanent artifacts. They capture the context, reasoning, and trade-offs of a decision at the time it was made.

### Creating a new ADR

- Use the template at `docs/adrs/0000-template.md`
- Number sequentially: find the highest existing number and increment
- Status: "Accepted" with today's date
- Include: Context (why this decision was needed), Decision (what was chosen), Consequences (positive and negative)

### Changing a decision

Never edit an accepted ADR. The original context and reasoning are historically valuable.

Instead:

1. Create a new ADR that supersedes the old one
2. In the new ADR, reference the old one: "Supersedes ADR-XXXX"
3. In the old ADR, add a note: "Superseded by ADR-YYYY" with the date
4. Keep the old ADR's original content intact

### When an ADR is required

- Choosing between architectural approaches (e.g., ADR-0001: bridge base class)
- Adding or removing dependencies (e.g., ADR-0002: devtunnels over ngrok)
- Changing system topology (e.g., ADR-0003: multi-tool architecture)
- Platform-specific decisions (e.g., ADR-0004: cross-platform support)
- Distribution changes (e.g., ADR-0005: single binary distribution)
- Process decisions (e.g., ADR-0006: test-driven bug fixes)

## History as Institutional Memory

`docs/history/` is the most important directory for autonomous AI agents. It's where lessons live.

LLMs don't carry memories between sessions. Every new session starts from zero context. The ONLY way to learn from past mistakes, debugging sessions, and hard-won insights is to write them down in `docs/history/`.

### What to document

- Non-trivial bug fixes (especially platform-specific ones)
- CI failure patterns and their solutions
- Cross-platform gotchas discovered during development
- Debugging sessions that took significant effort
- Performance issues and how they were resolved
- Dependency conflicts and their resolutions

### Format

File name: `YYYY-MM-DD-short-description.md`

Content structure:

```markdown
# Short Description

## What Happened
[The symptom or error observed. Include error messages, CI job names, platforms affected.]

## Root Cause
[What actually caused the issue. Be specific -- which file, which line, which assumption was wrong.]

## Fix
[What was changed and why. Reference commit hashes or PR numbers.]

## Watch For
[Conditions that might trigger the same issue again. What future agents should be careful about.]
```

### The rule

Before debugging any failure, check `docs/history/` first. If the problem has been solved before, the answer is already there. If it hasn't, document your solution after fixing it.

A solved problem that isn't documented is a problem that will be solved again.

## Stale Docs Are Bugs

Outdated documentation is not a low-priority cleanup task. It's a bug. It actively misleads the next agent, causing incorrect implementations, wasted CI cycles, and rework.

Treat stale docs with the same urgency as a failing test:

- If you notice a spec that doesn't match current behavior, update it immediately
- If you find an ADR that references deleted code, note it
- If a history entry has incorrect information, correct it
- If agent instructions reference outdated patterns, fix them

## Pre-Commit Documentation Checklist

Before every commit, ask yourself these 6 questions:

1. **Did I change behavior?** -- Update the relevant spec in `docs/specs/`
2. **Did I make an architectural decision?** -- Write an ADR in `docs/adrs/`
3. **Did I fix a bug?** -- Add a history entry in `docs/history/`
4. **Did I solve a non-obvious problem?** -- Add a history entry in `docs/history/`
5. **Did I change an API surface?** -- Update method signatures in the spec
6. **Did I introduce a new pattern?** -- Document it in `docs/architecture/`

If the answer to any of these is yes and you haven't updated docs, your commit is incomplete.
