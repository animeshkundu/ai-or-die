# npm Publish OIDC + Broken Runner npm (2026-04-13)

The release pipeline (`release-on-main.yml`) stopped publishing to npm after the GitHub Actions runner image updated. Two interacting bugs: a broken bundled npm that can't self-upgrade, and npm v10's lack of OIDC token exchange support.

---

## Symptoms

- `release-on-main` workflow fails at "Publish to npm" on every push to main
- Three distinct failure modes observed depending on the fix attempted:
  1. `MODULE_NOT_FOUND: promise-retry` — `npm install -g npm@latest` crashes
  2. `ENEEDAUTH` — npm has no auth token and can't perform OIDC exchange
  3. `E404 Not Found - PUT` — npm sends GITHUB_TOKEN to npmjs.org (wrong token)

---

## Root Cause

### Bug 1: Broken bundled npm on Node 22 runners

GitHub Actions `ubuntu-latest` runners ship Node 22.22.2 with npm v10.9.7. This npm version has a broken `@npmcli/arborist` module — `promise-retry` is missing from its dependency tree. Any `npm install -g` command triggers arborist's rebuild step and crashes:

```
npm error Cannot find module 'promise-retry'
npm error Require stack:
npm error - .../npm/node_modules/@npmcli/arborist/lib/arborist/rebuild.js
```

This means **npm cannot self-upgrade** via `npm install -g npm@latest` (or any pinned version). The old workflow relied on this step to get npm v11, which supported OIDC.

### Bug 2: npm v10 doesn't support OIDC token exchange

npm's OIDC trusted publishing (tokenless auth from GitHub Actions) requires **npm v11.5.1+**. The bundled npm v10.9.7 on Node 22 runners:
- Supports `--provenance` for SLSA attestation (signing works)
- Does NOT support OIDC-to-npm token exchange for authentication
- Requires `NODE_AUTH_TOKEN` with a real npm access token

### Bug 3: `actions/setup-node` injects wrong token

`actions/setup-node@v4` with `registry-url` writes `.npmrc` with `_authToken=${NODE_AUTH_TOKEN}` and sets `NODE_AUTH_TOKEN` to `GITHUB_TOKEN` at the job level. This GitHub token is accepted by GitHub Packages but rejected by npmjs.org (returns 404/403).

---

## Failed Approaches (in order)

| Attempt | Result | Why |
|---------|--------|-----|
| Remove `npm install -g npm@latest` | ENEEDAUTH | npm v10 can't do OIDC exchange |
| Remove `NODE_AUTH_TOKEN: ""` env override | 404 | GITHUB_TOKEN sent to npmjs.org |
| `npm config delete //registry.npmjs.org/:_authToken` | ENEEDAUTH | Didn't affect setup-node's npmrc path |
| `sed -i '/_authToken/d' "$NPM_CONFIG_USERCONFIG"` | ENEEDAUTH | npm v10 still can't OIDC |
| `unset NODE_AUTH_TOKEN` + sed | ENEEDAUTH | npm v10 still can't OIDC |
| `npm install -g npm@11` | MODULE_NOT_FOUND | Bundled npm can't self-upgrade |

---

## Fix

Use `npx` to run npm v11 directly, bypassing the broken bundled npm entirely:

```yaml
- name: Publish to npm
  run: |
    unset NODE_AUTH_TOKEN
    sed -i '/_authToken/d' "$NPM_CONFIG_USERCONFIG"
    npx --yes npm@11 publish --access public --provenance
```

This works because:
1. `npx` downloads npm@11 as a package (doesn't use `npm install -g`)
2. npm v11.5.1+ performs OIDC token exchange with the npm registry
3. `unset NODE_AUTH_TOKEN` removes setup-node's GITHUB_TOKEN injection
4. `sed` removes the `_authToken` from `.npmrc` so npm falls through to OIDC
5. `--provenance` adds SLSA attestation via sigstore

---

## Prerequisites for OIDC Trusted Publishing

All of these must be in place:

1. **npmjs.org**: Package must have the GitHub repo linked as a trusted publisher (package settings page)
2. **Workflow permissions**: `id-token: write` on the job
3. **npm version**: v11.5.1+ (Node 22 ships v10 — must upgrade)
4. **No conflicting auth**: `NODE_AUTH_TOKEN` must be unset, `.npmrc` must not have `_authToken` for the npm registry
5. **`--provenance` flag**: Triggers the OIDC flow in npm v11+

---

## Watch For

- **GitHub runner image updates**: If the runner npm version changes or the `promise-retry` bug is fixed, `npm install -g npm@11` may work again. But `npx npm@11` is safer — it's immune to the bundled npm's state.
- **Node version upgrades**: Node 24 ships npm v11 natively. When the project upgrades to Node 24, the `npx npm@11` workaround can be replaced with plain `npm publish`.
- **setup-node token injection**: `actions/setup-node` always injects `NODE_AUTH_TOKEN` when `registry-url` is set. Any workflow step that publishes via OIDC must unset it first.
- **"Published by" identity**: Successful OIDC publishes show `GitHub Actions <npm-oidc-no-reply@github.com>` on npmjs.org. If it shows a personal account, a token was used instead of OIDC.
