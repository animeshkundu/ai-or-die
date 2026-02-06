# ai-or-die Agent Organization

## Vision

ai-or-die is the AI agent infrastructure for Claude Code Web. It defines a team of specialized agents, each with a clear role, that collaborate through shared documentation to deliver high-quality, cross-platform software. Every decision is recorded, every change is tested, and every fix is documented.

## Team Roster

| Agent | Role | Persona File | Primary Focus |
|-------|------|--------------|---------------|
| **Architect** | System Designer | `agents/architect.md` | Specs, ADRs, diagrams |
| **Engineer** | Builder | `agents/engineer.md` | TDD implementation |
| **QA Reviewer** | Quality Gatekeeper | `agents/qa-reviewer.md` | Review, security, standards |
| **Troubleshooter** | Fixer | `agents/troubleshooter.md` | Debugging, root cause analysis |
| **Researcher** | Explorer | `agents/researcher.md` | Codebase and web research |

Agent persona files are located in both `.github/agents/` and `.claude/agents/`.

## Handoff Protocol

Agents collaborate through a defined handoff chain. Each handoff includes context passed via `docs/`.

```
Request --> Researcher (gather context)
               |
               v
         Architect (design + spec + ADR)
               |
               v
         Engineer (implement + test)
               |
               v
         QA Reviewer (review + approve/reject)
               |
               v
         Troubleshooter (if defects found)
               |
               v
         QA Reviewer (re-review after fix)
```

### Handoff Rules
1. The receiving agent must read all relevant docs before starting work
2. The sending agent must update docs with their output before handing off
3. If an agent identifies a gap in specs or ADRs, they escalate to the Architect
4. If a security issue is found at any stage, it goes directly to QA Reviewer

## Shared Documentation

All agents read from and write to the `docs/` directory:

| Directory | Purpose | Primary Authors |
|-----------|---------|-----------------|
| `docs/specs/` | Component specifications | Architect |
| `docs/adrs/` | Architecture Decision Records | Architect |
| `docs/architecture/` | System diagrams and overviews | Architect, Researcher |
| `docs/agent-instructions/` | Philosophy, research, testing, tooling guides | All agents |
| `docs/history/` | Incident post-mortems and debugging notes | Troubleshooter |

## Universal Tools

All agents have access to:

- **File operations**: Read, write, search, and navigate the codebase
- **Terminal**: Run npm scripts, git commands, and system utilities
- **Web search**: Research best practices, known issues, and documentation
- **Web fetch**: Retrieve and analyze content from URLs
- **Glob/Grep**: Pattern-based file and content search across the codebase

## Cross-Platform Mandate

All work must consider both Windows and Linux platforms. This applies to:
- File path handling (use `path.join()`, never hardcode separators)
- Shell scripts (provide both `.sh` and `.ps1` variants)
- CI pipelines (test on both `ubuntu-latest` and `windows-latest`)
- Documentation (note platform-specific instructions where needed)

## Quality Standards

- Every feature requires tests (Mocha + assert, in `test/`)
- Every architectural decision requires an ADR
- Every spec change requires corresponding code changes (and vice versa)
- Every bug fix requires a regression test and a `docs/history/` entry
- Commits follow Conventional Commits format
