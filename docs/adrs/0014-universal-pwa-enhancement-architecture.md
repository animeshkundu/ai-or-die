# ADR-0014: Universal PWA Enhancement Architecture

## Status

**Accepted**

## Date

2026-02-13

## Context

The project already ships as a browser-first PWA from `src/public/` with install, service worker, and mobile adaptations in place. The Universal PWA proposal in `docs/specs/universal-pwa.md` explored broad options, including platform-specific UX differences and iOS constraints.

We need a final architecture decision that preserves a single web codebase while clarifying what differs by platform. We also need an explicit decision on iOS strategy: all iOS browsers are WebKit-based, and installed behavior is constrained by WebKit and iOS PWA lifecycle rules.

## Decision

We will enhance the existing `src/public/` application as a single universal PWA codebase and will not create a separate `ios-app/` codebase.

Platform behavior is defined as:
- Desktop installed PWA (Windows/macOS/Linux): full functionality, including advanced features already available in the web app.
- Mobile installed PWA (iOS/Android): selective reductions only where interaction is impractical on small touch screens; core terminal and session workflows remain first-class.
- Web (not installed): remains fully supported.

iOS strategy is explicit:
- iOS support is delivered through the same PWA codebase.
- We design for WebKit constraints (install flow, background suspension, gesture limits, storage behavior) rather than trying to bypass them.
- No native iOS wrapper/app is introduced by default; revisit only if App Store distribution becomes a separate product requirement.

## Consequences

### Positive

- Avoids forked platform code and long-term divergence risk.
- Keeps feature development velocity high by concentrating effort in one frontend.
- Preserves full desktop capability while giving mobile targeted, practical UX reductions.
- Sets a clear, realistic iOS strategy aligned to platform constraints.

### Negative

- Mobile UX must be carefully scoped to avoid forcing desktop interactions onto small screens.
- Some iOS limitations cannot be eliminated and must be mitigated in product behavior.
- App Store-native expectations are deferred unless a future native distribution track is approved.

### Neutral

- Existing PWA infrastructure remains the foundation; this decision formalizes direction rather than replacing architecture.
- `docs/specs/universal-pwa.md` remains as implementation guidance and historical proposal context.

## Notes

- Cross-reference: `docs/specs/universal-pwa.md`
- The proposal context in `docs/specs/universal-pwa.md` is superseded as the governing architecture decision by this ADR.
