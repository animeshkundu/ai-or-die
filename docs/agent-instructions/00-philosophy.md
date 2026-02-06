# Core Philosophy

## Prime Directive

We do not guess. We research, we plan, we test, then we code.

## Principles

### 1. Documentation Drives Code

No code is written without a corresponding spec in `docs/specs/`. If the docs say X and the code says Y, the code is wrong. Before implementing any feature:

- Check `docs/specs/` for existing specification
- If no spec exists, write one first
- After implementation, update the spec to reflect the final state

### 2. Research Before Implementing

Every agent must search the web for current best practices before coding. Training data goes stale. Libraries change. APIs evolve. Before adding any dependency or implementing any pattern:

- Search for the current recommended approach
- Verify library versions are not deprecated
- Check for known CVEs or security advisories
- Document findings in the relevant ADR if it's an architectural decision

### 3. Test Alongside Code

No pull request without tests for new behavior. Tests are not an afterthought — they are written alongside (or before) the implementation. Target 90% coverage for all new code.

### 4. Measure Twice, Cut Once

Plan before executing. Read the existing code before modifying it. Understand the bridge pattern, the WebSocket protocol, and the session lifecycle before touching any of them. Check `docs/adrs/` for past architectural decisions to avoid regression.

### 5. Cross-Platform Always

Every code change must consider both Windows and Linux. Use `os.homedir()` not `process.env.HOME`. Use `path.join()` not string concatenation. Test path handling for both OS types. The CI pipeline runs on both platforms — if it doesn't pass on both, it doesn't merge.

## The CEO Model

When tackling complex tasks, the initiating agent acts as CEO — orchestrating sub-agents as workers. The CEO:

- Breaks the task into independent, parallelizable units
- Delegates to specialized agents (architect, engineer, QA, etc.)
- Monitors progress and resolves blockers
- Ensures the final result is coherent and tested

## Decision Records

Significant architectural decisions are recorded in `docs/adrs/`. Before making a decision that affects:
- How tools are integrated (bridge pattern)
- How data flows (WebSocket protocol)
- What dependencies are used
- How the system is deployed

Write an ADR first. The format is in `docs/adrs/0000-template.md`.
