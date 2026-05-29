## Summary

Describe the change and its motivation.

## Type of change

- [ ] Feature
- [ ] Bug fix
- [ ] Documentation / site
- [ ] Release prep (version bump / changelog)
- [ ] Test / test infrastructure
- [ ] Performance / longevity (campaign work)

## Gates I affect

<!--
Comma-separated list of soak-gate names from test/longevity/harness/gates.js
that this PR could plausibly affect (improve OR regress). If purely doc /
test-only, write "none".

Current gates: memory, handles, requests, fd, ws, fs_watch, event_loop,
disk.atomic_write, disk.bytes_used, disk.circuit_breaker, disk.quota.
-->

none

## Workloads exercised

<!--
Comma-separated list of soak-harness workload names that exercise the gates
above and so should be in the per-PR canary --workloads= flag. If none,
write "none".

Current workloads: noop, pty-flood, reconnect-storm, watcher-flood,
ws-fuzz, attachment-growth, session-stringify, mock-clock,
disk-bloat-jsonl, disk-bloat-quota.
-->

none

## Checklist

- [ ] Tests updated or not required
- [ ] README/Docs updated (if applicable)
- [ ] Spec under `docs/specs/` updated if behavior changed (CLAUDE.md rule 1)
- [ ] Audit memo under `docs/audits/` added if this PR closes an audit gap
- [ ] CHANGELOG entry under `[Unreleased]` added (Performance / Security / etc.)
- [ ] For release PRs: version bumped and CHANGELOG entry added
- [ ] For non-release PRs: pushed to a feature branch, NOT to main (auto-release fires on main push)

## Notes

Add any deployment notes, risks, or follow-ups.

For campaign PRs: link the per-PR canary `gate-result.json` if SOAK has run
the affected gates against this branch.
