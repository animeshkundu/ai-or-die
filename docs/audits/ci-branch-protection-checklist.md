# Branch protection setup — `main` (copy-paste runbook)

**Owner**: User (admin-only `gh api` call).
**Prerequisite**: the design in
[`ci-trigger-architecture.md`](./ci-trigger-architecture.md) is merged to
`main` (so the referenced job names exist as completed status checks on at
least one PR — GitHub's protection API will accept names that haven't run
yet, but the GUI dropdown shows only names from past runs).

## TL;DR

Run the single command below after the CI-trigger commit is on `main`.
Substitutions: replace `<TOKEN-HOLDER>` with your `gh` auth (already set if
`gh pr view` works for you).

```bash
gh api -X PUT repos/animeshkundu/ai-or-die/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "CI / test (ubuntu-latest)",
      "CI / test (windows-latest)",
      "CI / test-browser-golden (ubuntu-latest)",
      "CI / test-browser-golden (windows-latest)",
      "CI / test-browser-functional-core (ubuntu-latest)",
      "CI / test-browser-functional-core (windows-latest)",
      "CI / test-package (ubuntu-latest)",
      "CI / test-package (windows-latest)",
      "CI / build-binary (linux)",
      "CI / build-binary (win32)",
      "Longevity Smoke (PR-blocking) / smoke (ubuntu-latest)",
      "Longevity Smoke (PR-blocking) / smoke (windows-latest)",
      "Longevity Smoke (PR-blocking) / smoke (macos-latest)"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
EOF
```

## What each setting does

- **`required_status_checks.strict: true`** — branch must be up-to-date with
  `main` before merge (so the required checks run against the merge result,
  not a stale base). This is the standard "Require branches to be up to
  date before merging" toggle.
- **`required_status_checks.contexts`** — the 13 check names that MUST pass
  for merge. Sourced from the trigger-architecture doc §4. Includes the
  unit test on both OSes, the two stable browser projects, the package +
  binary smoke tests, and the tri-platform longevity smoke. Secondary
  `test-browser-*` projects (functional-extended, integrations, mobile-*,
  ux-features, etc.) are intentionally NOT required — they run on every
  PR and are visible, but blocking on all of them would make the merge gate
  brittle to flaky non-core surfaces.
- **`enforce_admins: false`** — admins (the user) can bypass. **This is the
  critical carve-out for `release-on-main.yml`**: that workflow uses
  `github-actions[bot]` (which has admin-equivalent `GITHUB_TOKEN` perms)
  to push `chore: bump version <X>` directly to `main` without a PR. Without
  this `false`, every release would be blocked by branch protection.
  Trade-off: humans with admin can force-merge a failing PR. Acceptable
  in a single-user repo; the discipline gate is "you, the admin, agreed
  not to."
- **`required_pull_request_reviews: null`** — no required reviewers.
  Single-user repo; reviewer requirement would block every PR forever.
- **`restrictions: null`** — no actor restrictions on who can push (only
  the admin can anyway).
- **`allow_force_pushes: false`** — defensive; do not allow `main` to be
  force-pushed.
- **`allow_deletions: false`** — defensive; do not allow `main` to be
  deleted.
- **`required_conversation_resolution: true`** — PR review comments must
  be resolved before merge. Adds a discoverability gate ("did the user
  actually engage with the PR's comments?") without forcing review-count
  blocking.

## Verification

After the `PUT` succeeds, confirm the rule:

```bash
gh api repos/animeshkundu/ai-or-die/branches/main/protection | jq '.required_status_checks.contexts'
```

Open a test PR and check the GitHub UI: the "Merge pull request" button
should be greyed out until all 13 checks go green, and the merge button
itself should show "13 checks pending" → "13 checks passed."

## Caveat: the release-bot push interaction

When `release-on-main.yml` fires after a merge:

1. It checks out `main`.
2. If the current tag exists, it runs `npm version patch` and pushes a
   `chore: bump version <X>` commit directly to `main`.
3. That push goes through WITHOUT branch protection blocking it, because
   `enforce_admins: false` lets the `GITHUB_TOKEN`-bearing admin-equivalent
   actor bypass.

If you see the release workflow fail with `Protected branch update failed`,
re-check `enforce_admins` is `false` (NOT `true`).

If you ever flip `enforce_admins: true` (e.g. to add a second admin in the
future), you must add `github-actions[bot]` to a bypass-allowances list,
which the v3 REST API does NOT expose cleanly; you'd need the GraphQL
`branchProtectionRule` mutation with `bypassPullRequestAllowances`. That's
out of scope today.

## Disabling the rule

If for any reason you want to drop branch protection entirely (e.g. to
debug a stuck release):

```bash
gh api -X DELETE repos/animeshkundu/ai-or-die/branches/main/protection
```

The rule can be re-applied by re-running the `PUT` above.

## References

- [`ci-trigger-architecture.md`](./ci-trigger-architecture.md) — the design
  this checklist implements.
- GitHub REST API: [Update branch protection](https://docs.github.com/en/rest/branches/branch-protection?apiVersion=2022-11-28#update-branch-protection)
- GitHub: [Required status checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/about-protected-branches#require-status-checks-before-merging)
