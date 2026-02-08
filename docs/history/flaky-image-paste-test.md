# Flaky Image Paste E2E Test

## Problem
`e2e/tests/09-image-paste.spec.js` — "Send button uploads image and closes modal" — intermittently failed on CI with `expect(uploadComplete).toBeTruthy()` receiving `undefined`.

## Root Cause
Race condition in WebSocket message assertion. The test:
1. Clicked the Send button
2. Waited for the modal to close (`expect(modal).not.toBeVisible()`)
3. **Immediately** read `page._wsMessages` synchronously

The modal closes when the client *sends* the upload message, but `image_upload_complete` arrives asynchronously from the server afterward. On slow CI runners, the server response hadn't arrived yet when the assertion ran.

## Fix
Added `waitForWsMessage(page, dir, type, timeout)` polling helper to `e2e/helpers/terminal-helpers.js`. This polls `page._wsMessages` every 100ms until the target message appears or timeout is reached.

Applied to both "Send button uploads" and "Complete flow" tests — both had the same synchronous read pattern.

## Lesson
Never assert on async WebSocket messages with a synchronous array lookup. Always poll/wait for the message to arrive, especially when the preceding UI action (modal close) happens before the server response.
