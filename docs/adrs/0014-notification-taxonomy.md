# ADR-0014: Three-Layer Notification Taxonomy

## Status

**Accepted**

## Date

2026-03-01

## Context

The codebase had 6+ fragmented notification patterns: `.clipboard-toast` (floating bottom-center div), `.mobile-notification` (top-center slide-down), `.notif-permission-prompt` (top-right static), `.sw-update-banner` (bottom-center with action), memory warning (ad-hoc inline-styled div), and voice feedback (reusing clipboard-toast). Each used different CSS classes, z-indices, positioning, animations, and lifecycle management.

Research into Material Design, Carbon Design System, Apple HIG, and VS Code's notification model revealed a clear three-layer taxonomy based on **origin** (who initiated), **urgency**, and **persistence**.

## Decision

We adopt a three-layer feedback taxonomy:

### Layer 1: Micro-Feedback (Inline Action Confirmations)
- **What**: Immediate, contextual confirmation of a user's direct action
- **Where**: Inline, at or adjacent to the triggering element (Gestalt proximity)
- **Duration**: 1-2 seconds, auto-revert, no manual dismissal
- **Example**: "Copied" badge in terminal header after Ctrl+C
- **Anti-pattern**: Using a floating toast for clipboard copy — disproportionate feedback for trivial action

### Layer 2: System Toasts (Transient System Events)
- **What**: Events requiring user awareness but not tied to their immediate point of interaction
- **Where**: Fixed top-right, stacking vertically
- **Duration**: info/success=4s, warning=6s, error=persistent
- **Example**: "Connection lost", "Voice transcription failed", "Update available"
- **API**: `window.feedback.info/success/warning/error(message, opts?)`

### Layer 3: Banners (Ongoing Conditions/States)
- **What**: Long-lived, stateful UI elements for persistent conditions
- **Where**: Fixed at top edge, full-width
- **Duration**: Persistent until condition resolves or user dismisses
- **Example**: Tunnel status, memory warning, download progress
- **Design**: Leave status indicator button (24x24px) in header when dismissed; click re-shows

Key principle: **Toasts are for events. Banners are for states. Micro-feedback is for direct action confirmation.**

## Consequences

### Positive
- Consistent mental model for users — each notification type has predictable behavior
- `FeedbackManager` singleton provides unified API for all toast-level notifications
- Shared `banner-base.css` gives visual consistency without a JavaScript manager for complex banners
- WCAG 2.2.1 compliance: actionable banners never auto-dismiss; informational auto-dismiss at 20s

### Negative
- Banner-level components (tunnel banners) retain their own DOM/lifecycle — they are too complex for a generic manager
- Two notification paths remain: desktop (Service Worker / Notification API) and in-app (FeedbackManager)

### Neutral
- The notification permission prompt migrated from custom DOM to `feedback.info()` with action button
- Memory warning migrated from ad-hoc inline-styled div to predefined banner-base element

## Notes

- Material Design: [Snackbar Guidelines](https://m3.material.io/components/snackbar/guidelines)
- Carbon Design System: [Notification Pattern](https://carbondesignsystem.com/patterns/notification-pattern/)
- Apple HIG: [Notifications](https://developer.apple.com/design/human-interface-guidelines/notifications)
- The notification center (bell icon + history dropdown) was evaluated and dropped — overkill for a single-user terminal app
