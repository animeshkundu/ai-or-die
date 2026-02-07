# Multi-Agent Consultation

## When In Doubt, Consult

Don't guess at architecture. Don't guess at testing strategy. Don't guess at UX. Don't guess at requirements.

When facing a decision that could go multiple ways, spawn specialized subagents to get expert perspectives before committing to an approach. The cost of consulting is a few minutes. The cost of guessing wrong is hours of rework, broken CI, and confused future agents.

This is not optional for significant decisions. This is how a well-run engineering org operates -- you get input from experts before making calls that affect the whole system.

If your runtime does not support spawning subagents, adopt the expert role yourself: explicitly state "Thinking as a Principal Engineer..." and reason from that perspective before proceeding. The goal is the expert thinking, not the subagent mechanism.

## Available Expert Roles

Beyond the 5 team agents (Architect, Engineer, QA Reviewer, Troubleshooter, Researcher), consult these senior perspectives when the situation calls for it:

### Architect

**When to consult:** System design, component boundaries, data flow, protocol changes.
**Ask for:** Design review, alternative approaches, risk assessment.

### Principal Engineer

**When to consult:** Deep technical decisions, performance trade-offs, system reliability, concurrency issues, platform-specific behavior.
**Ask for:** Technical feasibility assessment, performance implications, edge case analysis.

### Lead QA

**When to consult:** Test strategy, coverage gaps, regression risk, E2E test design, CI pipeline changes.
**Ask for:** Test plan review, risk assessment, coverage recommendations.

### Principal Program Manager

**When to consult:** Requirements clarity, scope decisions, feature prioritization, user-facing changes, backwards compatibility.
**Ask for:** Requirements validation, scope check, impact analysis.

### Designer

**When to consult:** UI/UX decisions, interaction patterns, accessibility, visual consistency, mobile behavior.
**Ask for:** Interaction review, accessibility audit, visual consistency check.

### Lead User Researcher

**When to consult:** User impact assessment, usability concerns, workflow analysis, onboarding experience.
**Ask for:** User impact assessment, usability review, workflow validation.

## Parallel Consultation

When facing a complex decision, spawn multiple expert subagents in parallel. Don't consult one at a time -- that wastes time.

### Example: Changing the WebSocket protocol

This affects architecture, implementation, testing, and user experience. Consult simultaneously:

- **Architect** -- Is the protocol change consistent with existing patterns? What are the migration concerns?
- **Principal Engineer** -- What are the performance implications? Are there concurrency edge cases?
- **Lead QA** -- What tests need to change? What regression risks exist?

All three can run in parallel and return independent assessments.

### Example: Adding a new UI component

- **Designer** -- Does it fit the existing design language? Is it accessible?
- **Lead User Researcher** -- Will users understand it? Does it fit the workflow?
- **Engineer** -- What's the implementation approach? What existing patterns apply?

### Example: Debugging a platform-specific CI failure

- **Troubleshooter** -- What's the root cause? What's the minimal fix?
- **Principal Engineer** -- Is there a deeper architectural issue? Will this recur?
- **Lead QA** -- What test coverage is missing? How do we prevent regression?

## How to Frame a Consultation

Give each subagent full context. A vague question gets a vague answer.

### What to include in every consultation request

1. **What you're trying to do** -- The goal, not just the task
2. **What you've considered** -- Options you've thought about and why you're unsure
3. **What constraints exist** -- Cross-platform requirements, performance budgets, backwards compatibility needs
4. **What you need back** -- A specific deliverable: recommendation, risk assessment, alternative approaches, code review

### Good consultation prompt

```
I need to add chunked file upload support to the WebSocket protocol.

Context: Currently image uploads send the entire base64 payload in one message.
For files over 1MB this causes WebSocket frame size issues on some browsers.

Options I'm considering:
1. Split into multiple WebSocket messages with sequence numbers
2. Use a separate HTTP upload endpoint
3. Use WebSocket binary frames with streaming

Constraints:
- Must work on both desktop and mobile browsers
- Must not break existing image paste flow
- Server must handle concurrent uploads from multiple sessions

Please assess each option for: implementation complexity, reliability,
cross-browser compatibility, and impact on existing code.
```

### Bad consultation prompt

```
How should I handle file uploads?
```

## When to Consult

Always consult for:

- **Architectural changes** -- New patterns, component restructuring, protocol changes
- **Breaking API changes** -- WebSocket message format, REST endpoint changes
- **New dependencies** -- Any npm package addition (Researcher for vetting, Architect for fit)
- **UX-visible changes** -- Anything a user would notice (Designer + User Researcher)
- **Test strategy changes** -- New testing patterns, CI pipeline changes (Lead QA)
- **Performance-critical code** -- Anything in the hot path (Principal Engineer)
- **Security-sensitive code** -- Auth, input validation, path traversal (Principal Engineer + QA)

Skip consultation for:

- Typo fixes
- Comment updates
- Straightforward bug fixes where the root cause is clear
- Documentation-only changes

## Synthesizing Advice

When experts disagree (and they will), handle it systematically:

1. **Document the disagreement** -- What does each expert recommend and why?
2. **Identify the core tension** -- Is it between performance and simplicity? Between speed and correctness?
3. **Make a decision** -- You can't wait for consensus. Weigh the arguments and choose.
4. **Record it in an ADR** -- Document what was decided, what alternatives were considered, and why you chose this path.
5. **Move forward** -- Don't second-guess. If the decision proves wrong later, a future agent can write a new ADR that supersedes.

Disagreement between experts is a signal that the decision is important, not that it's impossible.

## Post-Completion Review Is Mandatory

After completing any non-trivial work, spawn a reviewer subagent to review what you did before considering the task done. This is not optional.

Self-review is unreliable -- the same blind spots that led to mistakes in implementation will exist during self-review. An independent reviewer subagent operates with fresh context and catches issues you missed.

### What the reviewer should check

- Code correctness and edge cases
- Cross-platform compatibility (Windows + Linux)
- Test coverage completeness
- Documentation updates (specs, ADRs, history)
- Adherence to coding conventions
- Security concerns (input validation, path traversal, injection)
- Performance implications

### How to run the review

Spawn a QA Reviewer or Lead QA subagent with:

1. A summary of what was changed and why
2. The list of files modified
3. The relevant spec and ADR references
4. A request to verify: correctness, test coverage, doc completeness, cross-platform safety

The reviewer's findings should be addressed before marking the task as done. If the reviewer identifies issues, fix them and re-review. No work is complete until it has been independently reviewed.
