# Mobile Phone UX Audit Report

**Date:** February 12, 2026  
**Tested By:** QA Engineer (Automated Testing)  
**Test Devices:** iPhone SE (375×667), iPhone 14 (390×844)  
**Test Method:** Playwright browser automation with mobile viewport emulation

---

## Executive Summary

This audit tested the ai-or-die terminal web application on two common iPhone viewports: iPhone SE (375×667) and iPhone 14 (390×844). Testing included both portrait and landscape orientations, and covered all major UI components including the terminal, session tabs, bottom navigation, settings modal, and file browser.

**Overall Assessment:** The application is generally functional on mobile devices but has several critical and important issues that impact usability, particularly around touch targets, bottom navigation functionality, and the install button overlapping critical UI elements.

**Issues Found:**
- **Critical:** 1
- **Important:** 3  
- **Suggestion:** 3

---

## Test Scenarios Covered

### ✅ Successfully Tested
- Terminal display and rendering
- Session tab visibility and switching
- Settings modal display and scrolling
- New session creation
- Tab active/inactive visual states
- Landscape orientation adaptation
- Bottom navigation visibility

### ⚠️ Partially Tested
- File browser (button clicks but no modal appeared)
- More menu (button activates but no menu displayed)

### ❌ Not Tested
- Virtual keyboard interaction (requires real device)
- Touch scrolling smoothness (requires real device)
- Actual typing in terminal with mobile keyboard

---

## Critical Issues

### 1. Install App Button Overlaps Bottom Navigation

**Severity:** Critical  
**Viewports Affected:** iPhone SE (375×667), iPhone 14 (390×844)

**Description:**  
The "Install App" button appears at the bottom of the screen and overlaps the bottom navigation bar, blocking access to navigation buttons (Files, More, Settings). This makes critical functionality unreachable without dismissing the install prompt.

**Steps to Reproduce:**
1. Open app on iPhone SE or iPhone 14 viewport (375×667 or 390×844)
2. Observe the blue "Install App" button at bottom right
3. Try to tap Settings or More buttons in bottom nav
4. Clicks are blocked by the Install App button

**Impact:**  
Users cannot access Files, More, or Settings buttons until they either install the app or the install prompt is dismissed. This is a critical blocker for first-time users.

**Recommendation:**
- Add bottom padding to the Install App button to position it above the bottom nav: `bottom: calc(52px + env(safe-area-inset-bottom) + 8px)`
- Or automatically hide the install button when on mobile viewports
- Or add a close/dismiss button to the install prompt
- Consider showing install prompt as a banner at top instead of a floating button

**Files to Fix:**
- `src/public/style.css` or wherever `.install-btn` is styled
- Consider checking `src/public/index.html` for install button placement

---

## Important Issues

### 2. Voice Button in Bottom Navigation Has Zero Dimensions

**Severity:** Important  
**Viewports Affected:** iPhone SE (375×667), iPhone 14 (390×844)

**Description:**  
The Voice button in the bottom navigation bar has a width and height of 0px, making it invisible and untappable. The button exists in the DOM but is not rendered.

**Steps to Reproduce:**
1. Open app on mobile viewport
2. Look at bottom navigation bar
3. Observe only 3 visible buttons: Files, More, Settings
4. Voice button is missing/invisible

**Measurements:**
- Width: 0px
- Height: 0px
- Expected: At least 44×44px per Apple's Human Interface Guidelines

**Impact:**  
Users cannot access voice input functionality on mobile devices, where it would be most useful.

**Recommendation:**
- Check CSS for `.bottom-nav-item` with Voice content - may have `display: none` or `visibility: hidden`
- Verify the voice button is intentionally shown on mobile in `src/public/components/bottom-nav.css`
- If voice feature requires additional dependencies, show a disabled state with tooltip rather than hiding completely

**Files to Fix:**
- `src/public/components/bottom-nav.css`
- `src/public/index.html` (Voice button structure)
- `src/public/app.js` (Voice button initialization)

---

### 3. Bottom Navigation "Files" and "More" Buttons Don't Open Modals

**Severity:** Important  
**Viewports Affected:** iPhone SE (375×667), iPhone 14 (390×844)

**Description:**  
When tapping the "Files" or "More" buttons in the bottom navigation, the button becomes visually active (highlighted) but no modal or menu appears. This suggests the click handlers are not properly wired up or the modals are not being shown.

**Steps to Reproduce:**
1. Open app on mobile viewport
2. Tap "Files" button in bottom navigation
3. Button becomes active (highlighted) but no file browser appears
4. Tap "More" button in bottom navigation
5. Button becomes active but no menu appears

**Expected Behavior:**
- Tapping "Files" should open the file browser modal
- Tapping "More" should open a menu with additional actions

**Impact:**  
Two of the four bottom navigation buttons are non-functional, severely limiting mobile usability.

**Recommendation:**
- Verify click event handlers are properly attached to `#navFiles` and `#navMore` buttons
- Check if file browser modal exists and has correct display logic for mobile
- Confirm "More" menu implementation exists - may need to be created
- Review `src/public/app.js` for button event bindings

**Files to Fix:**
- `src/public/app.js` (event handlers)
- `src/public/file-browser.js` (file browser logic)
- May need to create a "More" menu component

---

### 4. Tab Close Buttons Below Minimum Touch Target Size

**Severity:** Important  
**Viewports Affected:** iPhone SE (375×667), iPhone 14 (390×844)

**Description:**  
The close buttons (×) on session tabs measure only 18×18px, which is significantly below Apple's recommended minimum touch target size of 44×44px. This makes them difficult to tap accurately, especially for users with larger fingers or accessibility needs.

**Steps to Reproduce:**
1. Open app with multiple sessions/tabs
2. Observe the × close button on each tab
3. Try to tap the close button
4. Frequently miss and tap the tab itself instead

**Measurements:**
- Current size: 18×18px
- Recommended minimum: 44×44px per Apple HIG
- Gap: 26px too small in each dimension

**Impact:**  
Users have difficulty closing tabs on mobile, leading to frustration and accidental tab switches when trying to close.

**Recommendation:**
- Increase `.tab-close` padding to create larger touch target: `min-width: 44px; min-height: 44px;`
- Keep the × icon small (18×18) but expand the clickable area with padding
- Consider using `@media (pointer: coarse)` to apply larger touch targets only on touch devices
- The CSS already has `@media (pointer: coarse) { .tab-close { min-width: 44px; min-height: 44px; } }` but it may not be taking effect

**Files to Fix:**
- `src/public/components/tabs.css` (lines 204-206 already have the fix, verify it's working)

---

## Suggestions

### 5. Session Tab Text Could Be More Readable

**Severity:** Suggestion  
**Viewports Affected:** iPhone SE (375×667) - less of an issue on iPhone 14

**Description:**  
Session tab labels use 11px font size on mobile, which is at the lower limit of readability. On the smaller iPhone SE viewport, tab text can be difficult to read quickly, especially the full session names that get truncated.

**Current Behavior:**
- Font size: 11px (iPhone SE)
- Tab names truncate with ellipsis (e.g., "ai-or-die 10:38...")
- Active vs inactive tabs distinguishable by color but text remains small

**Recommendation:**
- Consider 12px font size for tab names on mobile (current desktop is 12px)
- Increase contrast between active/inactive tab text
- Ensure truncation happens at appropriate point to show meaningful text
- Test with longer session names

**Files to Fix:**
- `src/public/components/tabs.css` (line 491-492, mobile tab-name styles)

---

### 6. Settings Modal Sections Could Use Better Spacing on Small Screens

**Severity:** Suggestion  
**Viewports Affected:** iPhone SE (375×667)

**Description:**  
The settings modal displays well on mobile and is scrollable, but the sections (Terminal, Voice Input, Notifications, etc.) feel slightly cramped on the iPhone SE viewport. There's little visual separation between sections.

**Current Behavior:**
- Settings modal is scrollable ✓
- All controls are reachable ✓
- Sections are expandable/collapsible ✓
- But sections feel visually crowded

**Recommendation:**
- Add 8-12px additional padding between section groups
- Consider making section headers slightly larger (currently same size as labels)
- Ensure sliders have adequate touch targets (currently appear okay)

**Files to Fix:**
- `src/public/components/modals.css` (modal body spacing)

---

### 7. Consider Larger Hit Areas for New Tab Buttons

**Severity:** Suggestion  
**Viewports Affected:** iPhone SE (375×667), iPhone 14 (390×844)

**Description:**  
The "New Session" button and dropdown arrow at the top are fairly small on mobile. While technically tappable, they could benefit from larger touch targets.

**Current Dimensions:**
- New tab main button: ~24×24px (+ button and dropdown)
- Dropdown arrow: ~14×14px

**Recommendation:**
- Increase to 32×32px for the main button on mobile
- Increase dropdown to 24×24px
- Already has mobile styles at lines 506-517 in tabs.css but could be larger

**Files to Fix:**
- `src/public/components/tabs.css` (`.tab-new-split` mobile styles)

---

## Positive Findings

### What Works Well ✅

1. **Terminal Display**
   - Terminal renders correctly on both viewports
   - Text is readable at default size
   - No horizontal overflow observed
   - Proper padding for terminal content

2. **Bottom Navigation Visibility**
   - Bottom nav correctly appears only on mobile viewports (<768px)
   - Fixed positioning works correctly
   - Safe area insets respected for notched devices
   - Visual design is clean and clear

3. **Session Tab Switching**
   - Tab switching works smoothly
   - Active/inactive states clearly distinguishable
   - Tab pills are appropriately sized for mobile
   - Visual status indicators (Active/Idle) work well

4. **Settings Modal**
   - Modal displays correctly on both viewports
   - Scrolling works properly
   - All settings are accessible
   - Close button is easily tappable
   - Collapsible sections save space effectively

5. **Landscape Orientation**
   - Layout adapts reasonably well to landscape
   - No content cut off
   - Bottom nav remains accessible
   - Terminal still usable

6. **Session Creation**
   - Creating new sessions works correctly
   - "Choose Your Assistant" overlay displays properly
   - Tool cards are readable and tappable

7. **Responsive Breakpoints**
   - 768px breakpoint works correctly for showing mobile UI
   - 480px breakpoint provides additional optimization
   - Media queries are well-structured

---

## Device-Specific Observations

### iPhone SE (375×667)

**Pros:**
- All content fits without horizontal scroll
- Terminal uses screen space efficiently
- Tab pills are appropriately compact

**Cons:**
- Smaller viewport makes the install button overlap more critical
- Tab text at 11px is at readability limit
- Less vertical space for terminal content

**Screen Usage:**
- Tab bar: ~36px
- Bottom nav: ~52px
- Terminal: ~579px (reasonable)

---

### iPhone 14 (390×844)

**Pros:**
- More vertical space for terminal content (~756px)
- Slightly wider allows for less text truncation
- Better overall readability

**Cons:**
- Same issues with install button overlap
- Voice button still hidden
- Files/More buttons still non-functional

**Screen Usage:**
- Tab bar: ~36px
- Bottom nav: ~52px
- Terminal: ~756px (excellent)

---

## Landscape Mode (Both Devices)

**Pros:**
- Layout adapts without breaking
- Bottom nav remains accessible
- Terminal content still visible

**Cons:**
- Less vertical space but acceptable
- Install button still potentially problematic

---

## Recommendations Priority

### High Priority (Fix Before Production)
1. ✅ Fix Install App button overlap with bottom navigation
2. ✅ Make Voice button visible or remove if not supported on mobile
3. ✅ Fix Files button to open file browser modal
4. ✅ Fix More button to show actions menu (or remove if no menu exists)

### Medium Priority (Improve UX)
5. ✅ Verify tab close button touch target size is working
6. ⚠️ Add More menu if it doesn't exist, or rebind button to existing functionality

### Low Priority (Polish)
7. ⚠️ Increase tab text size slightly if possible
8. ⚠️ Add more spacing to settings modal sections
9. ⚠️ Consider larger touch targets for new tab buttons

---

## Testing Notes

### Testing Methodology
- Used Playwright MCP browser automation
- Tested with real viewport dimensions (not just resized desktop)
- Enabled touch/mobile flags for accurate simulation
- Captured full-page screenshots for documentation
- Measured actual element dimensions programmatically

### Limitations
- Virtual keyboard behavior not tested (requires real device)
- Actual touch scrolling feel not evaluated (requires real device)
- Network conditions not simulated
- Device-specific performance not measured
- Haptic feedback not evaluated

### Recommended Follow-up Testing
1. Test on actual iPhone SE and iPhone 14 devices
2. Test virtual keyboard interaction with terminal input
3. Test touch scrolling through long terminal output
4. Test with slow network to verify loading states
5. Test voice input functionality if it should work on mobile
6. Test file browser modal with various folder structures
7. Test with 3+ sessions to verify tab overflow behavior

---

## Screenshots Reference

Screenshots captured during testing:

1. **iphone-se-home.png** - Initial app load on iPhone SE
2. **iphone-se-choose-assistant.png** - Tool selection overlay
3. **iphone-se-terminal.png** - Terminal view with bottom nav
4. **iphone-se-settings.png** - Settings modal
5. **iphone-se-two-tabs.png** - Multiple session tabs
6. **iphone-se-landscape.png** - Landscape orientation
7. **iphone-14-terminal.png** - Terminal view on larger screen
8. **iphone-14-landscape.png** - Landscape on iPhone 14

All screenshots available in test artifacts.

---

## Conclusion

The ai-or-die mobile experience is **functional but needs critical fixes** before it can be considered production-ready for mobile users. The terminal itself works well, but navigation and UI chrome have blocking issues:

**Must Fix:**
- Install button blocking bottom nav (Critical)
- Voice button invisible (Important)
- Files and More buttons non-functional (Important)

**Should Fix:**
- Tab close button touch targets (Important - though CSS rule exists, verify it works)

Once these issues are resolved, the mobile experience should be quite good. The core terminal functionality works well, the responsive design is thoughtfully implemented, and the bottom navigation is a good pattern for mobile.

**Estimated Fix Effort:** 2-4 hours for critical issues, 1-2 hours for important issues

---

## Appendix: Code Locations

### Files That Need Changes

1. **Install Button Overlap**
   - `src/public/style.css` - `.install-btn` styles
   - `src/public/index.html` - Install button structure

2. **Voice Button Hidden**
   - `src/public/components/bottom-nav.css` - Voice button visibility
   - `src/public/app.js` - Voice button initialization

3. **Files/More Button Not Working**
   - `src/public/app.js` - Event handler binding
   - `src/public/file-browser.js` - File browser modal logic

4. **Tab Close Touch Targets**
   - `src/public/components/tabs.css` - `.tab-close` mobile styles (verify line 204-206)

### Relevant CSS Breakpoints

```css
/* Tablets and below */
@media (max-width: 768px) { ... }

/* Extra small devices (phones in portrait) */
@media (max-width: 480px) { ... }

/* Touch devices */
@media (pointer: coarse) { ... }
```

---

**Report Generated:** February 12, 2026  
**Test Duration:** ~30 minutes  
**Testing Tool:** Playwright MCP with Mobile Emulation
