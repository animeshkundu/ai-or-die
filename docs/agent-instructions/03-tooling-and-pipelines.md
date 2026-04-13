# Tooling and Pipelines

## Automation Rule

If you perform a verification task twice, script it. All scripts live in the `scripts/` directory.

### Current Scripts

- `scripts/validate.sh` — Linux validation (lint, test, docs check)
- `scripts/validate.ps1` — Windows validation (same checks)
- `scripts/release-pr.sh` — Release process automation

## CI/CD Pipeline

### GitHub Actions

The CI pipeline (`.github/workflows/ci.yml`) runs on every push and PR. It runs 8 job types in parallel across ubuntu-latest and windows-latest (16 total jobs):

- **Unit tests**: `npm test` + `npm audit`
- **Browser E2E tests**: 6 Playwright job types (golden-path, functional-core, functional-extended, mobile, visual-regression, new-features)
- **Binary build**: SEA binary compilation + smoke tests

See `06-ci-first-testing.md` for the full CI job map, artifact details, and debugging workflow. CI is the only authority on whether code works (see ADR-0008 for the parallelization strategy).

### Release Pipeline

The release pipeline (`.github/workflows/release-on-main.yml`) triggers on push to main:

1. Read version from `package.json`
2. Check if git tag already exists; auto-bump patch if it does
3. Generate release notes from conventional commit log
4. Create GitHub Release with tag
5. `npm ci` then publish to npm via OIDC trusted publishing
6. Publish to GitHub Packages (scoped `@animeshkundu/ai-or-die`)
7. Build and attach SEA binaries (Linux x64, Windows x64)

#### npm OIDC Trusted Publishing

The pipeline publishes to npm **without an NPM_TOKEN secret** — it uses OIDC trusted publishing. Key requirements:

- **npm v11.5.1+** is required (Node 22 ships v10, which can't do OIDC). The workflow uses `npx --yes npm@11 publish` to bypass the bundled npm.
- **`id-token: write`** permission must be set on the job.
- **`NODE_AUTH_TOKEN` must be unset** before publishing — `actions/setup-node` injects `GITHUB_TOKEN` which npmjs.org rejects.
- **`_authToken` must be removed** from the `.npmrc` that `setup-node` generates.
- **`--provenance`** flag enables SLSA attestation via sigstore.

See `docs/history/npm-oidc-publish-fix.md` for the full debugging story and failed approaches.

**Do not** add `npm install -g npm@latest` or any global npm upgrade — the bundled npm v10 on Node 22 runners has a broken arborist that crashes on self-upgrade.

## Tool Creation Guidelines

When creating new scripts:

- Use `#!/bin/bash` for Linux scripts, PowerShell for Windows
- Include error handling and meaningful exit codes
- Add usage instructions as comments at the top
- Make scripts idempotent (safe to run multiple times)

## Dependency Management

- Pin major versions in `package.json` (use `^` for minor/patch)
- Run `npm audit` before adding any new dependency
- Prefer packages with:
  - Active maintenance (commits within last 6 months)
  - No known vulnerabilities
  - Cross-platform support
  - Minimal transitive dependencies

## Code Quality

- **Linter**: ESLint (configured in project)
- **Style**: 2-space indentation, semicolons, single quotes
- **Naming**: kebab-case files, PascalCase classes, camelCase functions
- **Comments**: Only where the logic isn't self-evident
