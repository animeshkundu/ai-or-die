# File Browser: Bugs Found During CI (2026-02-07)

9 bugs caught during file browser implementation — 4 by E2E tests on GitHub runners, 3 by UX reviewer subagent, 2 by architect reviewer subagent. All were real code bugs, not test bugs.

---

## 1. Panel z-index below terminal overlay

**What Happened:** E2E tests on CI could not click file browser panel items. Playwright reported the terminal overlay (`#overlay`, z-index 5000) was intercepting pointer events.

**Root Cause:** The file browser panel used `z-index: var(--z-sticky)` (1100), which is below the terminal overlay at 5000. The overlay briefly appears during connection setup.

**Fix:** Set panel z-index to 5001 (above overlay).

**Watch For:** Any new panel or modal must check its z-index against the terminal overlay (5000) and the existing z-index scale in `tokens.css`.

---

## 2. Panel missing tabindex for keyboard focus

**What Happened:** E2E Escape key test failed — pressing Escape did not close the panel.

**Root Cause:** The panel `<div>` had no `tabindex` attribute. Without it, `element.focus()` has no effect and `keydown` events never fire on the element.

**Fix:** Added `tabindex="-1"` to the panel div.

**Watch For:** Any container that needs to receive keyboard focus must have `tabindex="-1"`. This includes modals, panels, dialogs, and any div with a `keydown` listener.

---

## 3. No document-level Escape fallback

**What Happened:** Even with tabindex fix, Escape was unreliable when focus was elsewhere (e.g., terminal, body).

**Root Cause:** The panel's `keydown` listener only fires when the panel or a child has focus. If the user clicks elsewhere, Escape goes to the focused element, not the panel.

**Fix:** Added a `document.addEventListener('keydown', ...)` fallback that checks `if (panel._open && e.key === 'Escape')`.

**Watch For:** Keyboard shortcuts that should work globally need document-level listeners, not just component-level ones. Panel-level handlers are for internal keyboard navigation; document-level handlers are for global shortcuts.

---

## 4. Status bar "Saving..." never visible

**What Happened:** UX reviewer found that during saves, the status bar showed "Editing" instead of "Saving...".

**Root Cause:** The ternary in `_updateCursorPosition` was `this._dirty ? 'Editing' : (this._saving ? 'Saving...' : 'Ready')`. Since `_dirty` is true during the save (cleared on success), the `_saving` branch was never reached.

**Fix:** Swapped to `this._saving ? 'Saving...' : (this._dirty ? 'Editing' : 'Ready')`.

**Watch For:** When multiple boolean flags control display state, check the evaluation order. The most important/transient state should be checked first.

---

## 5. Escape double-fire between panel and Ace Editor

**What Happened:** UX reviewer found that pressing Escape while Ace's search bar was open would close both the search bar AND the editor simultaneously.

**Root Cause:** Ace's Escape command closes its search bar, but the DOM event still propagates to the panel's `keydown` handler, which then calls `editorPanel.close()`.

**Fix:** Panel-level handler now returns early when `_currentView === 'editor'` (delegates to Ace). Document-level fallback checks for visible `.ace_search` before closing.

**Watch For:** When embedding a third-party editor (Ace, Monaco, CodeMirror), its keyboard handling operates independently of DOM event propagation. The outer container must check whether the editor consumed the event before acting.

---

## 6. Screen reader announcements defined but never called

**What Happened:** UX reviewer found `FileEditorPanel._announceToScreenReader()` was defined at line 523 but never invoked anywhere in the file.

**Root Cause:** The method was written but calls were not added at the key state transitions (save start, save success, save failure, conflict detected).

**Fix:** Added `_announceToScreenReader()` calls at 4 points: save start ("Saving"), save success ("File saved"), save failure ("Save failed"), conflict ("File was modified externally").

**Watch For:** Any method that updates visual status should also announce to screen readers. Add a grep check: every status-changing method should have a corresponding `_announceToScreenReader` call.

---

## 7. CSS/JS class name mismatch (30+ selectors)

**What Happened:** Architect reviewer found the entire panel rendered unstyled because CSS and JS used different naming conventions.

**Root Cause:** `file-browser.css` was written by one subagent using `file-browser-*` prefix, while `file-browser.js` was written by another subagent using `fb-*` prefix. Neither checked the other's naming convention.

**Fix:** Rewrote CSS to use `fb-*` prefix matching the JS, and added ~30 missing selectors.

**Watch For:** When CSS and JS are written by different agents (or in parallel), establish the naming convention upfront. Add a pre-merge check: grep all `className` assignments in JS and verify each has a corresponding CSS selector.

---

## 8. _showConflictDialog silently drops parameter

**What Happened:** Architect reviewer found that the 409 conflict response data (containing `currentHash`) was passed to `_showConflictDialog(d)` but the method signature was `function ()` with no parameter.

**Root Cause:** The function signature omitted the parameter. JavaScript doesn't error on extra arguments, so the data was silently discarded.

**Fix:** Added `conflictData` parameter and used `conflictData.currentHash` to store the server's hash.

**Watch For:** When a function is called with arguments, verify the callee's signature accepts them. This is easy to miss in vanilla JS without TypeScript.

---

## 9. Search bar CSS display:none vs JS style.display conflict

**What Happened:** E2E search filter test failed — the search input was "hidden" despite JS toggling its display.

**Root Cause:** CSS had `.fb-search-bar { display: none; }` and `.fb-search-bar.visible { display: block; }`. But JS was using `element.style.display = ''` (empty string) to show it. When inline `style.display` is empty, the CSS `display: none` rule takes precedence, so the element stays hidden.

**Fix:** Changed JS to use `classList.add('visible')` / `classList.remove('visible')` instead of inline style.

**Watch For:** Never mix CSS class-based visibility (`display: none` in stylesheet) with inline `style.display` toggling. Pick one mechanism. CSS classes are preferred because they keep styling in CSS.
