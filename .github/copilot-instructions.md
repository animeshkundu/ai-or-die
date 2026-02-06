# Copilot Instructions for ai-or-die

This file configures GitHub Copilot behavior for the Claude Code Web project. These instructions align with the agent framework defined in `.github/agents/` and the project conventions in `CLAUDE.md`.

## Core Principles

1. **Spec-driven development**: Before writing or modifying code, consult `docs/specs/` for the relevant specification. If no spec exists, one must be created before implementation begins.
2. **ADR compliance**: Check `docs/adrs/` for existing architectural decisions. Never contradict an accepted ADR without proposing a new one that supersedes it.
3. **Cross-platform mandate**: All code must work on both Windows and Linux. Avoid hardcoded paths, platform-specific APIs without fallbacks, and shell-specific syntax in application code.
4. **Test-first**: Every feature and bug fix requires tests. Use Mocha with Node's `assert`. Tests live in `test/*.test.js`.
5. **Documentation is not optional**: When code behavior changes, the corresponding spec in `docs/specs/` must be updated in the same PR.

## Reference Documentation

- **Agent instructions**: `docs/agent-instructions/` contains philosophy, research guidelines, testing standards, and tooling conventions
- **Architecture Decision Records**: `docs/adrs/` contains numbered decision records (use `docs/adrs/0000-template.md` as the template)
- **Specifications**: `docs/specs/` contains detailed specs for each major component
- **Architecture diagrams**: `docs/architecture/` contains system design and component relationship docs

## Code Style

- Language: Node.js (CommonJS modules)
- Indentation: 2 spaces
- Quotes: single quotes
- Semicolons: required
- File naming: kebab-case for modules, PascalCase for classes, camelCase for functions/variables
- Test naming: `*.test.js` in the `test/` directory

## Commit Convention

Follow Conventional Commits:
- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `test:` for test additions or modifications
- `chore:` for maintenance tasks
- `refactor:` for code restructuring without behavior change

## Security

- Never commit secrets, tokens, or credentials
- Use `--auth <token>` flag for authentication; never hardcode tokens
- Validate all user input, especially file paths (prevent directory traversal)
- Run `npm audit` as part of CI and address moderate+ vulnerabilities

## Agent Handoff Protocol

When working on a task, consider which agent persona is most appropriate:
1. **Architect** (`agents/architect.md`): Design and specification work
2. **Engineer** (`agents/engineer.md`): Implementation and TDD
3. **QA Reviewer** (`agents/qa-reviewer.md`): Code review and security audit
4. **Troubleshooter** (`agents/troubleshooter.md`): Debugging and incident response
5. **Researcher** (`agents/researcher.md`): Investigation and knowledge gathering

Each agent reads from and writes to `docs/` to maintain shared context across the team.
