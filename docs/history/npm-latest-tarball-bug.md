# npm `@latest` Arborist Crash (2026-03-24)

`npx ai-or-die@latest` crashed with `Invalid Version:` inside npm arborist's `canDedupe`. The bug only triggered with the `@latest` dist-tag; every other version specifier worked. Root cause was dev artifact leakage into the tarball, which exposed an npm arborist bug in its dedup code path.

---

## Symptoms

- `npx ai-or-die@latest` fails with `Invalid Version:` stack trace from `@npmcli/arborist` `canDedupe`
- `npx ai-or-die@0.1.51`, `npx ai-or-die@*`, `npx ai-or-die@^0`, `npx ai-or-die@>=0.1.51` all work
- `npm install ai-or-die@latest` works (only `npx` fails)
- Regression between v0.1.49 (101 tarball files, works) and v0.1.51 (206 files, breaks)
- Dependencies are identical between both versions

---

## Root Cause

### Tarball bloat from incomplete .npmignore

The `.npmignore` was missing exclusions for dev artifacts: `.github/`, `.claude/`, `.cursor/`, `.prompts/`, `docs/`, `site/`, `e2e/`, `poc/`, `test-results/`, `scripts/`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md`, `CONTRIBUTING.md`. This leaked 105 extra files into the tarball (206 total, up from 101).

### Arborist dedup bug with dist-tags

When `npx` resolves a dist-tag like `@latest`, arborist takes a `REPLACE` code path in `placeDep` (as opposed to `OK` for direct version specifiers). This triggers deduplication of sherpa-onnx-node's optional platform packages against a node with an empty version string. The empty version comes from the npx temp project's root node, which has no `version` field in its generated `package.json`. Arborist calls `semver.parse('')`, gets null, and crashes in `canDedupe`.

The larger tarball (206 files) changes the install tree shape enough to trigger this code path. The smaller tarball (101 files) does not.

### Reproduction details

- Reproduced on npm 10.9.2, 11.8.0, 11.12.0 across Node 22 and 24
- `--install-strategy=nested` bypasses the bug because it skips dedup entirely
- In npm debug logs, look for `REPLACE for:` vs `OK for:` in `placeDep` lines to distinguish the two code paths

---

## Fix

1. **Expanded `.npmignore`** to exclude all dev artifacts. Tarball reduced from 206 files to ~85 files.
2. **Fixed hardcoded version** in `bin/ai-or-die.js`: replaced `.version('0.1.0')` with dynamic read from `package.json`.
3. **Added package smoke test suite** (`scripts/smoke-test-package.js`) that validates the tarball end-to-end.

---

## Verification

After any publish:
- `npm pack --dry-run` must show <=100 files
- `npx ai-or-die@latest --version` must return the correct version (not `0.1.0`)
- `node scripts/smoke-test-package.js` must pass all assertions

---

## Package Smoke Test Coverage

`scripts/smoke-test-package.js` runs 40 assertions across 12 steps:

| Step | What it validates |
|------|-------------------|
| 1-2 | Tarball creation and clean install in a temp directory |
| 3-4 | CLI `--version` matches `package.json`, `--help` shows all flags |
| 5 | Both bin entries linked (`ai-or-die`, `aiordie`), platform-aware (`.cmd` on Windows) |
| 6-7 | Production files present, dev/CI files excluded |
| 8 | Native modules load: `node-pty` `spawn()`, `sherpa-onnx-node`, platform-specific sherpa binary |
| 9 | Server starts, `/api/health` returns 200 |
| 10 | WebSocket connects, receives `connectionId` |
| 11 | Session creation via WebSocket |
| 12 | Terminal spawns (node-pty E2E) and echoes a unique marker back |

Steps 1-8 validate packaging correctness. Steps 9-12 validate runtime correctness of the installed package.

---

## Debugging Tips

- **npm debug logs**: set `npm_config_loglevel=silly` or check `Q:\.tools\.npm\_logs\` for full arborist traces.
- **Compare working vs failing**: in the debug output, search for `REPLACE for:` vs `OK for:` in `placeDep` lines. Working installs use `OK`; failing installs use `REPLACE`, which enters the dedup path.
- **sherpa-onnx version**: working installs resolve sherpa-onnx-node to 1.12.33; failing ones may resolve to an older version or fail during dedup before resolution completes.
- **If the bug recurs**: check tarball file count first with `npm pack --dry-run`. If it exceeds ~100 files, the `.npmignore` is incomplete.
- **Quick workaround**: `npx --install-strategy=nested ai-or-die@latest` bypasses arborist dedup and avoids the crash. This is not a fix, just a diagnostic confirmation.

---

## Watch For

- Any new top-level directory or file added to the repo needs a corresponding `.npmignore` entry. Without it, npm includes everything by default.
- The `bin/ai-or-die.js` version must read from `package.json` dynamically, never be hardcoded. The smoke test catches this (step 3).
- sherpa-onnx-node's optional platform dependencies are the trigger for the arborist bug. If sherpa-onnx-node changes its dependency structure, re-verify `npx @latest` after publish.
