# General file upload via attach button + paste (not just drag-drop)

## Problem
General (non-image) file upload to the CLI agent only worked via **drag-and-drop**.
The other two attachment surfaces were image-only:
- The **attach button** (`#attachImageBtn`) and context-menu **"Attach Image…"** opened an `image/*`-filtered picker.
- **Paste** (OS paste event + context-menu "Paste Image") only detected `image/*` in the clipboard.

So a user could *drop* a PDF and have the agent read it via the injected `@<path>`,
but the same file rejected from the attach button and paste — an inconsistent UX.

## Fix
Routed every non-drop surface through the **existing** generic pipeline instead of
duplicating it:

- `generic-drop-handler.js` now surfaces its internal drop dispatcher as a public
  **`dispatchFiles(fileList)`** on the handler return object, and exports a
  **`triggerFilePicker(onFiles, { multiple })`** (a `<input type="file">` with no
  `accept` filter).
- `app.js` gained **`_attachFiles(files)`**, which partitions client-side: image
  files take the **unchanged** preview → `image_upload` path; everything else goes
  to `dispatchFiles` (upload to `.claude-attachments/` + `@<path>` inject). The
  attach button and context-menu "Attach File…" open the generic picker → `_attachFiles`.
- `image-handler.js`'s paste listener keeps image precedence; *after* the image
  branch declines, non-image clipboard files surface via a new
  `options.onFilesPaste` → `_attachFiles`. New `collectNonImageFiles` helper.
- UI relabeled "Attach Image" → **"Attach File"**. The async-clipboard "Paste Image"
  context item stays image-only (the Clipboard API can't retrieve arbitrary files;
  the OS Ctrl+V path is the non-image route).

## Hard constraint honored: no image regression
Image upload, paste, and the preview modal are byte-identical — image code paths
were not modified; all non-image handling is a strictly additive fall-through.

## Windows-first hardening (folded in)
Because this productizes arbitrary-file upload, `sanitizeFileName`
(`src/utils/file-utils.js`) — the one server chokepoint all uploads pass through —
was hardened for the primary deployment target (Windows 11): strip NTFS-forbidden
`< > : " | ? *` (the `:` neutralizes Alternate Data Streams), trim trailing
dot/space, and prefix reserved device names (`CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9`)
with `_`.

## Deferred (separate follow-up)
Cross-CLI `@<path>` injection: the reference is hardcoded Claude-native `@`-syntax;
Gemini/Codex/terminal sessions receive it verbatim and it is unverified whether they
interpret it. The bridge already tracks `session.agent`, so a future change can
branch the injection form.

## Lesson
When a feature has multiple entry surfaces (drop / button / paste), factor the
core pipeline into one reusable entry point and have every surface call it — three
hand-written copies drift. The image flow stayed safe precisely because the new
non-image handling was layered *after* it, never inside it.
