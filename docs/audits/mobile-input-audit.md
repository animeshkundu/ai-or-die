# Mobile Input Audit Report

**Date:** February 12, 2026  
**Devices Tested:** iPhone 14 (390x844), Pixel 7 (412x915)  
**Test Framework:** Playwright with Device Emulation  
**Test Suite:** `50-mobile-input-audit.spec.js`

---

## Executive Summary

This audit evaluates the text input, copy/paste, and keyboard interaction experience on mobile viewports in the Claude Code Web terminal application. **All 40 automated tests passed** across both iPhone 14 and Pixel 7 emulations, indicating robust fundamental functionality. However, several UX concerns and limitations were identified through code analysis and test observations.

**Overall Grade:** B+ (Functional but with UX improvement opportunities)

---

## Test Coverage

### Tests Executed (20 per device, 40 total)

✅ **Basic Input**
- Text input via typing
- Special character input
- Keyboard open/close cycle stability (10 iterations)

✅ **Extra Keys Bar**
- Visibility and basic functionality
- Tab key
- Arrow keys (up, down, left, right)
- Special character keys (|, /, -, ~, _)
- Ctrl modifier toggle
- Ctrl+C sequence (SIGINT)
- Esc key

✅ **Advanced Input**
- Rapid typing and input buffering
- Long command text wrapping
- Large paste handling (>64KB)
- Clipboard integration

✅ **Layout & Responsiveness**
- Terminal visibility with virtual keyboard
- Keyboard detection threshold
- Landscape mode adaptation
- Viewport overflow prevention
- Mobile detection accuracy

✅ **Context Menu**
- Accessibility attempts (long-press)

---

## Findings by Category

### 1. Text Input Paths

#### ✅ **PASS: Basic typing works correctly**
- **Test:** `basic text input: typing in terminal`
- **Devices:** iPhone 14, Pixel 7
- **Observation:** Standard text input via keyboard works reliably. Characters are captured and rendered correctly in the terminal.
- **Code Reference:** `src/public/app.js:564-597` (input buffering via `onData`)

#### ✅ **PASS: Special characters are supported**
- **Test:** `special characters input`
- **Devices:** iPhone 14, Pixel 7
- **Observation:** Characters like `!@#$%^&*()_+-=[]{}\\|;:'",.<>?` are transmitted correctly.
- **Code Reference:** Terminal passes through all keyboard data without filtering.

#### ⚠️ **CONCERN: Input buffering uses requestAnimationFrame**
- **Issue:** Input is buffered and flushed via `requestAnimationFrame()` (lines 592-593 in app.js)
- **Risk:** In headless/emulated environments without vsync, rAF may not fire reliably, causing input lag
- **Mitigation in code:** Safety cap at 64KB triggers immediate flush (line 587-589)
- **Recommendation:** Consider adding a timeout-based fallback (e.g., flush after 16ms if rAF hasn't fired)
- **Severity:** Low (mostly a CI testing concern, real devices should be fine)

---

### 2. Keyboard Open/Close Cycles

#### ✅ **PASS: Layout remains stable across 10 focus/blur cycles**
- **Test:** `keyboard open/close cycle: layout stability`
- **Devices:** iPhone 14, Pixel 7
- **Observation:** Viewport dimensions remain consistent after 10 repeated keyboard open/close events. No drift detected.
- **Code Reference:** Terminal element height is adjusted in `_setupExtraKeys` (lines 628-631)

#### ⚠️ **LIMITATION: Keyboard detection threshold is hardcoded**
- **Code:** `app.js:626` — `if (heightDiff > 150)`
- **Issue:** The 150px threshold for detecting keyboard open may not be optimal for all devices
- **Examples:**
  - Small keyboards on compact devices (<150px) won't trigger extra keys bar
  - Split keyboards or floating keyboards may not trigger detection
  - iPad mini keyboard heights vary
- **Recommendation:** Make threshold configurable or use a percentage-based approach (e.g., 25% of viewport height)
- **Severity:** Medium

#### 💡 **OBSERVATION: visualViewport API dependency**
- **Code:** `app.js:617` — `if (!this.isMobile || !window.visualViewport)`
- **Note:** Extra keys bar only works if `window.visualViewport` is supported
- **Browser Support:** Excellent on modern browsers, but may fail on older mobile browsers
- **Recommendation:** Document minimum browser requirements (Chrome 61+, Safari 13+)

---

### 3. Extra Keys Bar Functionality

#### ✅ **PASS: All extra keys function as expected**
- **Tests:** Multiple tests covering Tab, Esc, arrows, special chars, Ctrl
- **Devices:** iPhone 14, Pixel 7
- **Observation:** Every key in the extra keys bar sends the correct input
- **Code Reference:** `src/public/extra-keys.js:32-46` (key definitions)

**Key Mappings Verified:**
- Tab → `\t`
- Esc → `\x1b`
- Left → `\x1b[D`
- Right → `\x1b[C`
- Up → `\x1b[A`
- Down → `\x1b[B`
- Special chars → `|`, `/`, `-`, `~`, `_`

#### ✅ **PASS: Ctrl modifier works correctly**
- **Test:** `extra keys bar: Ctrl modifier`, `extra keys bar: Ctrl+C sequence`
- **Observation:** Ctrl toggles active state and intercepts next keypress
- **Code:** `extra-keys.js:69-87` implements toggle + visual feedback
- **Verified:** Ctrl+C sends SIGINT and interrupts `sleep` command

#### ⚠️ **UX ISSUE: Ctrl modifier is stateful (can confuse users)**
- **Code:** `extra-keys.js:72` — `this.ctrlActive = !this.ctrlActive`
- **Issue:** If a user taps Ctrl and then doesn't type anything, the modifier remains active until they tap Ctrl again or type a character
- **User Impact:** Users may forget Ctrl is active and accidentally send control codes
- **Recommendation:** Add a timeout (e.g., 3 seconds) to auto-deactivate Ctrl if no key is pressed
- **Severity:** Low-Medium

#### 💡 **MISSING FEATURE: No Alt, Shift, or Meta modifiers**
- **Observation:** Only Ctrl is available in the extra keys bar
- **User Impact:** Cannot send Alt+key or Meta+key combinations on mobile
- **Use Cases:** Alt+F (forward word), Meta+K (clear screen on some shells)
- **Recommendation:** Consider adding Alt and possibly Shift keys in a future iteration
- **Severity:** Low (edge case for most users)

---

### 4. Copy/Paste Interactions

#### ✅ **PASS: Clipboard API integration works**
- **Test:** `paste text: clipboard integration`
- **Code:** Terminal handles Ctrl+V for paste
- **Observation:** Pasting via Ctrl+V successfully inserts clipboard content

#### ⚠️ **LIMITATION: Context menu not accessible on mobile**
- **Test:** `context menu: attempt to access (mobile browsers may not support)`
- **Code:** `app.js:2326-2368` — Context menu triggered via `contextmenu` event
- **Issue:** Mobile browsers don't reliably fire `contextmenu` events; long-press typically triggers system context menu instead
- **User Impact:** Users cannot access Copy/Paste/Clear commands via context menu on mobile
- **Current Workaround:** Users must use keyboard shortcuts (Ctrl+C, Ctrl+V) or system clipboard
- **Recommendation:**
  - Add a "Paste" button to the mobile menu (hamburger)
  - Consider implementing a custom long-press handler for mobile
- **Severity:** Medium

#### ⚠️ **OBSERVATION: No visual paste button**
- **Code Analysis:** No dedicated paste button in extra keys bar
- **Issue:** Users must remember Ctrl+V or use the virtual keyboard's paste option
- **Recommendation:** Add a "Paste" key to the extra keys bar for discoverability
- **Severity:** Low-Medium

---

### 5. Virtual Keyboard Visibility

#### ✅ **PASS: Terminal remains visible when keyboard is open**
- **Test:** `terminal visibility with virtual keyboard open`
- **Code:** `app.js:628-631` — Terminal height is adjusted to `(currentHeight - 44)px` to accommodate extra keys bar
- **Observation:** Terminal resizes correctly, and user can see typed commands above the keyboard

#### ⚠️ **UX CONCERN: Extra keys bar height reduces visible terminal area**
- **Code:** `components/extra-keys.css:7` — Extra keys bar is 44px tall (portrait), 36px (landscape)
- **Impact:** On small devices (iPhone SE: 375x667), visible terminal area is significantly reduced when keyboard is open
- **Calculation:** iPhone SE with keyboard (~260px) + extra keys (44px) leaves ~363px for terminal
- **Recommendation:** Consider making extra keys bar collapsible or movable
- **Severity:** Low (acceptable tradeoff for functionality)

#### ✅ **PASS: Terminal does not overflow viewport**
- **Test:** `terminal does not overflow viewport`
- **Observation:** No horizontal scrolling detected; terminal width stays within viewport bounds

---

### 6. Rapid Typing and Input Buffering

#### ✅ **PASS: Rapid typing is buffered correctly**
- **Test:** `rapid typing: input buffering`
- **Code:** `app.js:584-594` — Breather-flush pattern accumulates keystrokes
- **Observation:** Typing 36 characters with 0ms delay resulted in all characters being captured
- **Performance:** Input buffer prevents overwhelming the WebSocket with individual character sends

#### ✅ **PASS: Large paste handling**
- **Test:** `input buffer: large paste handling`
- **Code:** `app.js:586-589` — Buffer exceeding 64KB is flushed immediately
- **Observation:** Pasting 70,000 characters did not crash the app
- **Behavior:** Large pastes bypass the rAF buffer and send immediately

#### 💡 **RECOMMENDATION: Add paste size warning**
- **Observation:** Pasting extremely large text (>64KB) may overwhelm the terminal or backend
- **Suggestion:** Show a confirmation dialog for pastes exceeding 10KB
- **Example:** "You're about to paste 12,000 characters. Continue?"
- **Severity:** Low

---

### 7. Landscape Mode Adaptation

#### ✅ **PASS: Extra keys bar adapts to landscape orientation**
- **Test:** `landscape mode: extra keys adaptation`
- **Code:** `components/extra-keys.css:59-69` — Media query for `orientation: landscape`
- **Behavior:**
  - Portrait: 44px height, 36px key height
  - Landscape: 36px height, 30px key height
- **Observation:** Keys remain tappable and visible in landscape mode

#### ⚠️ **UX CONCERN: Extra keys bar may obscure more terminal content in landscape**
- **Issue:** Landscape viewports have less vertical space (e.g., iPhone 14 landscape: 390px height)
- **Impact:** 36px extra keys bar + ~200px keyboard = only ~154px for terminal
- **Recommendation:** Consider auto-hiding extra keys bar in landscape mode
- **Severity:** Low-Medium

#### 💡 **MISSING FEATURE: No orientation change handler for terminal resize**
- **Observation:** Tests manually call `setViewportSize()` but real devices fire `orientationchange` events
- **Code:** Terminal resize is handled via `visualViewport.addEventListener('resize')` (line 622)
- **Status:** Likely handled automatically, but should be explicitly tested on real devices
- **Recommendation:** Add manual testing on physical devices with orientation changes

---

### 8. Text Wrapping

#### ✅ **PASS: Long commands wrap correctly**
- **Test:** `long command: text wrapping`
- **Observation:** Typing 200 'a' characters did not break terminal rendering
- **Code:** xterm.js handles line wrapping automatically based on terminal column count

#### 💡 **OBSERVATION: Terminal column count is device-dependent**
- **iPhone 14 (390px width):** Approximately 40-50 columns
- **Pixel 7 (412px width):** Approximately 45-55 columns
- **Behavior:** Controlled by xterm.js FitAddon based on font size and viewport width
- **Recommendation:** Document expected column counts for common mobile devices

---

### 9. Keyboard Detection Threshold

#### ⚠️ **LIMITATION: Hardcoded 150px threshold (reiterated)**
- **Test:** `keyboard detection threshold: extra keys visibility`
- **Code:** `app.js:626` — `if (heightDiff > 150)`
- **Test Observation:** Test simulates visualViewport resize but cannot fully replicate real browser behavior
- **Real-world Risk:**
  - Floating keyboards (iPad) may not trigger 150px height change
  - Split keyboards may not trigger at all
  - Browser UI chrome (URL bar) collapse/expand may cause false positives
- **Recommendation:** Use a percentage-based threshold (e.g., 20% of viewport height) instead of fixed pixels
- **Severity:** Medium

---

### 10. Mobile Detection

#### ✅ **PASS: Mobile devices are detected correctly**
- **Test:** `mobile detection: isMobile flag is set correctly`
- **Code:** `app.js` line ~109-135 (detectMobile function)
- **Observation:** Playwright device emulation correctly triggers `app.isMobile = true`
- **Detection Logic:**
  - User agent regex matching
  - Touch support detection
  - Screen size heuristics
- **Status:** Robust across tested devices

---

## Additional Code Review Findings

### Security
✅ **No security vulnerabilities identified** in input handling code
- Input is properly escaped before transmission over WebSocket
- No eval() or innerHTML usage in input paths
- XSS risk is mitigated by xterm.js canvas rendering

### Accessibility
⚠️ **Limited accessibility features**
- Extra keys have `aria-label` attributes (good)
- No screen reader testing performed
- No keyboard-only navigation (relies on touch)
- **Recommendation:** Test with mobile screen readers (VoiceOver, TalkBack)

### Performance
✅ **Input performance is optimized**
- RequestAnimationFrame batching reduces WebSocket overhead
- 64KB safety cap prevents memory issues
- No observed lag in test environments

### Browser Compatibility
⚠️ **Requires modern browser APIs**
- `window.visualViewport` (Chrome 61+, Safari 13+, Firefox 91+)
- Clipboard API (Chrome 66+, Safari 13.1+)
- WebSockets (universal support)
- **Recommendation:** Add feature detection and graceful degradation

---

## Issues Summary Table

| # | Issue | Severity | Component | Line(s) |
|---|-------|----------|-----------|---------|
| 1 | Hardcoded 150px keyboard detection threshold | Medium | app.js | 626 |
| 2 | Context menu not accessible on mobile | Medium | app.js | 2326-2368 |
| 3 | No paste button in extra keys bar | Low-Medium | extra-keys.js | N/A |
| 4 | Ctrl modifier remains active (no timeout) | Low-Medium | extra-keys.js | 69-87 |
| 5 | Extra keys bar reduces visible terminal area | Low | extra-keys.css | 7 |
| 6 | No Alt/Shift/Meta modifiers in extra keys | Low | extra-keys.js | 17-30 |
| 7 | rAF input buffering may stall in headless | Low | app.js | 592-593 |
| 8 | No paste size warning for large pastes | Low | app.js | 584-597 |
| 9 | Limited accessibility (screen reader) testing | Low | All | N/A |
| 10 | No auto-hide extra keys in landscape | Low-Medium | extra-keys.css | 59-69 |

---

## Recommendations

### Immediate (High Priority)
1. **Make keyboard detection threshold configurable**
   - Replace `heightDiff > 150` with `heightDiff > (window.innerHeight * 0.20)`
   - Add configuration option for users to adjust threshold

2. **Add mobile-accessible paste button**
   - Add "Paste" key to extra keys bar
   - Alternative: Add paste button to mobile hamburger menu

3. **Improve context menu accessibility**
   - Implement custom long-press handler for mobile
   - Show context menu after 500ms touch-hold
   - Add option to hamburger menu

### Short-term (Medium Priority)
4. **Add Ctrl modifier timeout**
   - Auto-deactivate Ctrl after 3 seconds of inactivity
   - Show visual countdown or pulse animation

5. **Add paste size confirmation**
   - Detect pastes >10KB
   - Show dialog: "Paste X characters? (This may take a moment)"

6. **Improve landscape UX**
   - Add option to auto-hide extra keys in landscape
   - Consider swipe-up gesture to reveal extra keys

### Long-term (Nice to Have)
7. **Expand modifier key support**
   - Add Alt key to extra keys bar
   - Consider Shift for uppercase/symbols

8. **Improve input buffering robustness**
   - Add timeout fallback for requestAnimationFrame
   - Use `setTimeout(() => flush(), 16)` if rAF doesn't fire within 20ms

9. **Accessibility improvements**
   - Test with VoiceOver (iOS) and TalkBack (Android)
   - Add ARIA live regions for output
   - Support keyboard-only navigation

10. **Real device testing**
    - Test on physical iPhone 14, Pixel 7, iPad Mini
    - Verify keyboard detection on split keyboards
    - Test with third-party keyboards (SwiftKey, Gboard)

---

## Test Limitations

### Emulation vs. Real Devices
- **Limitation:** Playwright device emulation does not perfectly replicate real mobile browsers
- **Gaps:**
  - Real keyboard behavior (iOS keyboard != Android keyboard)
  - Touch gestures (long-press, swipe) are simulated, not native
  - Hardware-specific quirks (notch handling, safe areas)
- **Recommendation:** Conduct manual testing on physical devices before release

### Headless Environment
- **Limitation:** Tests run in headless Chromium without GPU
- **Gaps:**
  - visualViewport resize events may not fire naturally
  - requestAnimationFrame timing differs from real devices
  - Canvas rendering performance not representative
- **Mitigation:** Tests include manual viewport manipulation and forced flushes

### Network and Latency
- **Limitation:** Tests run against localhost with minimal latency
- **Real-world:** Mobile users may experience network delays
- **Recommendation:** Add network throttling tests (slow 3G/4G simulation)

---

## Conclusion

The Claude Code Web mobile terminal input system is **functionally sound** with all core features working as intended. The extra keys bar provides essential terminal navigation (arrows, Tab, Ctrl) and special characters that are otherwise hard to type on mobile keyboards.

**Key Strengths:**
- Robust input buffering and handling
- Comprehensive extra keys coverage
- Layout stability across keyboard open/close cycles
- Good landscape adaptation
- No critical bugs or crashes

**Key Areas for Improvement:**
- Mobile context menu accessibility
- Paste button visibility
- Configurable keyboard detection threshold
- Ctrl modifier UX (timeout)
- Landscape mode optimization

**Overall Assessment:** The app provides a solid mobile terminal experience for technical users. With the recommended improvements, it could achieve excellent mobile UX parity with desktop.

---

## Test Suite Information

**Test File:** `e2e/tests/50-mobile-input-audit.spec.js`  
**Total Tests:** 20 per device, 40 total  
**Pass Rate:** 100% (40/40 passed)  
**Execution Time:** ~2 minutes  
**CI Compatibility:** ✅ Compatible with GitHub Actions

### Running the Tests

```bash
# Run audit on both devices
npm run test:browser -- --project=mobile-input-audit-iphone --project=mobile-input-audit-pixel

# Run on iPhone 14 only
npm run test:browser -- --project=mobile-input-audit-iphone

# Run on Pixel 7 only
npm run test:browser -- --project=mobile-input-audit-pixel

# Generate HTML report
npm run test:browser -- --project=mobile-input-audit-iphone --project=mobile-input-audit-pixel --reporter=html
```

---

**Audited by:** GitHub Copilot Agent  
**Report Generated:** February 12, 2026  
**Version:** ai-or-die v0.1.43
