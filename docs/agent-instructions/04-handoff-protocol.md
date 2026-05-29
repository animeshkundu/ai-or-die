# Handoff Protocol

## The Golden Rule

Every session ends with a cleaner repo than it started. If you touched it, you documented it. If you broke it, you fixed it. If you couldn't finish, you left a trail.

## HEAD-discipline (worktree-mandatory rule)

**Ratified during the stability-hardening-2026 campaign after multi-supervisor HEAD-collision losses on the shared root checkout.**

Rule: **only SUP-REL (the release / integration supervisor) operates on the shared root checkout, and only READ-ONLY.** Every other supervisor — including any single-context agent doing work alongside a campaign — commits and switches branches ONLY inside their own dedicated git worktree.

Why this rule exists: the shared root's `HEAD` is a single mutable pointer. When supervisor A runs `git checkout sup-a/feature`, supervisor B's subsequent `git commit -a` for what they think is a main-bound change lands on `sup-a/feature` instead. We hit this 4× during one campaign — each recovery cost 3 min via patch-extract → reset → checkout → `git am`, and one collision contaminated SUP-B's commit with SUP-A's staged files (resolved via soft-reset + selective re-stage). Cumulative cost: ~15 min in PROC's lane alone, equivalent to a 30 % tax on their day-1 throughput.

Operational specifics:

- **Each supervisor** creates exactly one worktree per concurrent line of work: `git worktree add .claude/worktrees/sup-<lane> <branch-or-base-ref>`. All commits, branch switches, and `git push`es happen from that worktree's working directory.
- **SUP-REL** never `git checkout`s on the shared root. Read-only verification uses path-targeted forms:
  - `git show <branch>:<path>` to read a file at a specific branch
  - `git ls-tree <branch> -- <path>` to enumerate a branch's files
  - `git -C <worktree-path> <command>` to inspect another supervisor's worktree without changing the root
  - `git ls-remote --heads origin <pattern>` to verify what's pushed without local-state confusion
- **5-worktree cap** (slots 1–5 per the campaign plan). Slot 5 is SUP-REL's spare for urgent regression-fix turns. Plan supervisors with shared codepaths to alternate (e.g. PROC and DISK both touch persistence; never concurrent).
- **24-hour cleanup discipline**: once a supervisor's fix-PR cycle is merged, they `ExitWorktree({action:"remove"})` within 24 h. SUP-REL audits daily via `git worktree list`.
- **Verify-pushed-to-origin** is a hard step before declaring "done": local-only work on a worktree is fragile (the worktree could be removed or the disk lost). SUP-SOAK and SUP-HOT both lost work to "I'll commit at the end" patterns during the campaign — push as you go.

## Pre-Handoff Checklist

Before ending any work session, verify:

1. **All CI jobs pass.** Push to your branch and check GitHub Actions. Both `ubuntu-latest` and `windows-latest` must be green. Do not hand off a red build.
2. **Documentation is updated.** Specs in `docs/specs/` match the current code. ADRs are written for any architectural decisions made during the session.
3. **No orphaned work-in-progress.** No half-implemented features sitting uncommitted. Everything is either committed and pushed, or explicitly tracked in a GitHub issue.
4. **Commit messages explain "why", not just "what".** A future agent reading the git log should understand the reasoning without opening the diff.
5. **New patterns and conventions are documented.** If you introduced a new coding pattern, utility, or convention, write it down in the relevant spec or instruction doc.

## Work-in-Progress Protocol

When you cannot finish a task:

- Create a GitHub issue with full context: what was attempted, where it stopped, what blockers exist, and what the next steps are.
- Use `[WIP]` prefix in commit messages for incomplete work.
- List which files are mid-change and what state they are in.
- Reference relevant specs, ADRs, and CI run links.
- Never leave broken tests on main. If your work breaks tests, either fix them or revert before ending.

## Clean Commit Hygiene

- Follow Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`.
- One concern per commit. Do not mix a bug fix with a feature addition.
- Reference GitHub issues in the message: `fix: resolve WebSocket race in image upload (#42)`.
- Commit messages should be self-contained. Another agent reading the git log should understand what happened and why without reading the diff.

## Session Context Dump

What to leave behind for the next agent:

- Updated specs in `docs/specs/` reflecting any behavior changes.
- Research findings documented in the relevant ADR or spec.
- Error patterns discovered during debugging added to `docs/history/`.
- Decisions made and their rationale recorded in ADRs.
- If you modified the CI pipeline, document what changed and why.

## Log What You Solved

When you encounter and solve a problem, document it in `docs/history/`. LLMs do not carry memories between sessions -- written docs are the only institutional memory. Every solved problem that is not documented is a problem that will be solved again.

See `07-docs-hygiene.md` for the history entry format and full guidelines. Before debugging any issue, always check `docs/history/` first.

## Anti-Patterns

Do NOT do any of these:

- Leave vague commit messages like "Made some changes" or "Updated stuff".
- Push uncommitted or unstaged work.
- Leave broken tests and move on.
- Make architectural decisions without writing an ADR.
- Solve a problem without documenting the solution.
- Skip spec updates when behavior changes.
- Assume the next agent will "figure it out".
- Delete or disable tests to make CI pass.
- Commit secrets, API keys, tokens, or `.env` files. Check `git diff --staged` for sensitive data before every commit.
- Expand scope beyond what was asked. If you discover adjacent issues, file them as separate GitHub issues. Do not expand scope without explicit approval.
