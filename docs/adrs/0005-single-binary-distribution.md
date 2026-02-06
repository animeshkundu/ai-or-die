# ADR 0005: Single Binary Distribution via Node.js SEA

## Status

Accepted

## Context

Users currently install ai-or-die via `npm install -g ai-or-die` or `npx ai-or-die`, both of which require Node.js and npm to be pre-installed. A single binary distribution would allow download-and-run without a Node.js runtime, simplifying distribution and onboarding.

The main challenge is the `@lydell/node-pty` dependency, which ships platform-specific prebuilt native `.node` files and helper binaries (conpty.dll, OpenConsole.exe on Windows; spawn-helper on Linux).

## Decision

Use **Node.js Single Executable Application (SEA)**, available as a stable feature since Node 22. This is the only actively maintained, officially supported approach for packaging Node.js apps as standalone binaries.

### Build pipeline

1. **esbuild** bundles all JavaScript into `dist/bundle.js`, with `@lydell/node-pty` marked as external (native modules cannot be bundled)
2. Static assets (`src/public/**`) and platform-specific native `.node` prebuilts are collected as SEA assets
3. `node --experimental-sea-config` generates a preparation blob
4. The blob is injected into a copy of the Node binary using `postject`
5. The resulting binary is uploaded to GitHub Releases

### Runtime behavior

A `sea-bootstrap.js` wrapper detects SEA mode and:
- Extracts native `.node` files to a temp directory
- Patches `Module._resolveFilename` to redirect `@lydell/node-pty` requires
- Cleans up the temp directory on exit

Static assets are served from the SEA blob via a custom Express middleware that uses `sea.getRawAsset()`.

## Alternatives Considered

| Option | Why not |
|--------|---------|
| `pkg` (Vercel) | Deprecated since 2023, unmaintained |
| `nexe` | Sporadic maintenance, limited Node 22+ support |
| Bun compile | Requires Bun runtime; `@lydell/node-pty` is Node-specific |
| Standalone tarball | Not a single file; still requires manual extraction |

## Consequences

### Positive
- Zero-install distribution: download binary, run it
- Binaries attached to GitHub Releases automatically
- No Node.js runtime required on user machines

### Negative
- Binary size ~80-100MB (includes Node.js runtime)
- Native addon extraction to temp directory at startup adds ~100ms
- Must build on each target platform (no cross-compilation)
- External CLI tools (Claude, Copilot, Gemini) must still be installed separately

### Neutral
- npm installation remains the primary distribution method
- SEA binaries are a convenience alternative, not a replacement
