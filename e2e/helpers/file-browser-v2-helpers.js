// Helpers shared across the file-browser-v2 E2E specs (56-66).
//
// Centralises:
//   - Per-test fixture directory bookkeeping (created inside the repo so
//     they pass server-side validatePath()).
//   - `git init` for tests that need ripgrep to honour .gitignore (rg
//     only respects .gitignore inside a real git repo — see commit
//     a166689's note from systems-engineer).
//   - OSC 7 emit through the running shell, using a portable shell
//     command (`printf '\033]7;file://...\007'`) so the test exercises
//     the real PTY → osc7-parser.js → broadcast `cwd_changed` flow.
//   - Drop-event simulation that mirrors what a browser fires when the
//     user drops files onto the terminal container.
//
// All helpers stay framework-agnostic (don't import @playwright/test);
// individual specs decide what to assert against the values returned.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const FB_V2_FIXTURE_ROOT = path.join(__dirname, '..', 'fixtures', 'file-browser-v2');

/**
 * Create an empty isolated fixture directory under
 * e2e/fixtures/file-browser-v2/<slug>-<rand>/. Lives inside the repo
 * (so validatePath() approves it), and gets a deterministic slug prefix
 * for easier debugging when tests leave them around on a failure.
 *
 * Returns the absolute path. Caller must clean up via `cleanupFixture`.
 */
function makeFixtureDir(slug) {
  fs.mkdirSync(FB_V2_FIXTURE_ROOT, { recursive: true });
  const safe = String(slug || 'fb2').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  // mkdtempSync needs the prefix path passed as the FULL prefix.
  return fs.mkdtempSync(path.join(FB_V2_FIXTURE_ROOT, safe + '-'));
}

/**
 * Recursive remove + tolerate ENOENT (e.g. the test never created it
 * before failing in beforeAll). Never throws.
 */
function cleanupFixture(dirPath) {
  if (!dirPath) return;
  try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

/**
 * Initialise a git repo at `dirPath` so `rg --files` will honour any
 * .gitignore present. Uses the system git binary; -q to silence init
 * output. We DON'T configure a user/email — these fixtures don't make
 * commits; init alone is enough for ripgrep's "is this inside a repo"
 * check.
 */
function gitInitFixture(dirPath) {
  execFileSync('git', ['init', '-q', dirPath], { stdio: 'ignore' });
}

/**
 * Write a file inside the fixture, ensuring parent dirs exist.
 */
function writeFileInside(dir, relPath, content) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/**
 * Build a portable shell printf invocation that emits an OSC 7 sequence
 * targeting `cwdAbs`. Uses BEL (\007) terminator (universally accepted)
 * and a single-quoted printf format string so neither bash nor zsh
 * will substitute anything inside.
 *
 * The trailing newline is intentional — the WebSocket `input` handler
 * sends the bytes as keyboard input, and we need a CR to make the
 * shell actually execute the printf.
 *
 * Cross-platform note: on Windows pwsh you'd emit OSC 7 differently
 * (see docs/specs/file-browser.md "Shell hook documentation"); this
 * helper targets the POSIX shells that the e2e suite runs against
 * (bash + zsh on macOS/Linux).
 */
function osc7EmitCommand(cwdAbs) {
  // POSIX path → file://localhost/<abs>; abs already starts with "/".
  // We percent-encode spaces only; other characters in a typical fixture
  // path don't need encoding.
  const enc = String(cwdAbs).replace(/ /g, '%20');
  return "printf '\\033]7;file://localhost" + enc + "\\007'\r";
}

/**
 * Fire a synthetic drag-and-drop on the given container element with a
 * list of File objects constructed from the supplied { name, mimeType,
 * base64 } descriptors.
 *
 * Runs entirely inside `page.evaluate()` because File / DataTransfer
 * can only be constructed in the browser context (Node's `Blob` doesn't
 * convert losslessly across the page boundary).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} selector  CSS selector of the drop target
 * @param {Array<{name:string, mimeType:string, base64:string}>} files
 */
async function dispatchDrop(page, selector, files) {
  await page.evaluate(({ sel, payload }) => {
    const target = document.querySelector(sel);
    if (!target) throw new Error('dispatchDrop: target not found: ' + sel);
    const dt = new DataTransfer();
    payload.forEach((f) => {
      const bin = atob(f.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], f.name, { type: f.mimeType });
      dt.items.add(file);
    });
    // dragover first — required for drop to fire by spec.
    target.dispatchEvent(new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer: dt,
    }));
    target.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: dt,
    }));
  }, { sel: selector, payload: files });
}

/**
 * Drive the xterm link provider's `provideLinks` for the row containing
 * the given hint text and call the matched link's `activate` synchronously.
 *
 * This mirrors what xterm does internally on a Ctrl/Cmd+click on an
 * underlined link, but doesn't depend on per-cell pixel coordinates
 * (which are fragile across viewports + DPR). Reaches into the
 * terminal's internal `_linkProviderService` for the registered
 * provider — the public API doesn't expose them but the field name has
 * been stable across xterm 5.x.
 *
 * Returns true if a link was activated; false if the row didn't contain
 * a recognised path.
 */
async function activateTerminalLink(page, hintText) {
  return page.evaluate((needle) => {
    const term = window.app && window.app.terminal;
    if (!term) return Promise.resolve(false);
    const buf = term.buffer.active;
    let foundRow = -1;
    for (let row = 0; row < buf.length; row++) {
      const line = buf.getLine(row);
      if (!line) continue;
      const text = line.translateToString(true);
      if (text.indexOf(needle) >= 0) { foundRow = row; break; }
    }
    if (foundRow < 0) return Promise.resolve(false);
    // Convert absolute buffer row to viewport-relative row. The link
    // provider's `provideLinks` operates in 1-based viewport rows.
    const viewportRow = foundRow - buf.viewportY + 1;

    // Prefer the captured test provider if present (the spec attaches
    // its own copy via window.fileBrowser.attachLinkProvider), so the
    // activate path runs through the closure we control. Falls back to
    // the production-registered provider via xterm's internals.
    let provider = window._fbV2TestLinkProvider || null;
    if (!provider) {
      try {
        const svc = term._core && term._core._linkProviderService;
        const list = svc && (svc._linkProviders || svc.linkProviders);
        if (list && list.length) provider = list[list.length - 1];
      } catch (_) { /* ignore */ }
    }
    if (!provider || typeof provider.provideLinks !== 'function') {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      try {
        provider.provideLinks(viewportRow, (links) => {
          if (!Array.isArray(links) || !links.length) { resolve(false); return; }
          // Pick the link whose text contains the needle — the row may
          // have several detected paths if the test prints more than
          // one.
          let chosen = null;
          for (const lk of links) {
            const t = lk.text || '';
            if (t.indexOf(needle) >= 0 || needle.indexOf(t) >= 0) { chosen = lk; break; }
          }
          if (!chosen) chosen = links[0];
          try {
            chosen.activate(new MouseEvent('click'), chosen.text || needle);
            resolve(true);
          } catch (e) {
            resolve(false);
          }
        });
      } catch (_) {
        resolve(false);
      }
    });
  }, hintText);
}

module.exports = {
  FB_V2_FIXTURE_ROOT,
  makeFixtureDir,
  cleanupFixture,
  gitInitFixture,
  writeFileInside,
  osc7EmitCommand,
  dispatchDrop,
  activateTerminalLink,
};
