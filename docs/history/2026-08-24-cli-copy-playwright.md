# Claude and Copilot CLI copy coverage

## What changed

The Playwright copy gate now starts both tool-specific production bridge routes
with a deterministic Node fixture. The fixture emits a stable Claude- or
Copilot-labelled marker, remains alive for the copy action, and avoids requiring
either external CLI, credentials, or network access in CI.

Desktop Chromium uses the context-menu fallback with no xterm selection.
iPhone16 WebKit uses the ADR-0037 Control-mode keys panel and checks that the
panel does not open the soft keyboard or change terminal geometry.

## Evidence

The following screenshots were captured from the iPhone16 WebKit project after
the successful copy action:

![Claude Code copy](2026-08-24-cli-copy/claude-copy.png)

![GitHub Copilot copy](2026-08-24-cli-copy/copilot-copy.png)

## Reproducing the evidence

```bash
AIORDIE_CLI_COPY_SCREENSHOT_DIR="$PWD/docs/history/2026-08-24-cli-copy" \
  npx playwright test --config e2e/playwright.config.js \
  --project=client-redesign-webkit --grep "CLI-specific terminal copy"
```

The test always attaches the screenshot to the Playwright result. The
environment variable only enables writing the two tracked PNGs.
