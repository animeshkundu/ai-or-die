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
2. Check if git tag already exists
3. Create GitHub Release with tag
4. Publish to npm

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
