# ADR-0048: visual viewport and safe areas

## Status

Accepted (2026-08-04).

## Context

The iOS layout viewport does not reliably represent the visible area while browser chrome or the virtual keyboard changes. Safe-area handling also covered only vertical insets and was partly gated on standalone display mode.

## Decision

This decision extends ADR-0037 without changing its Compose and Control modes.

`ViewportRegime` owns visible height and offset values from `visualViewport`, coalesces changes through animation frames, detects keyboard state against a stable orientation-aware visual baseline, and clears residual offset after dismissal. Layout uses dynamic viewport units where a viewport unit is required.

The design system exposes top, right, bottom, and left safe-area tokens. Edge-anchored surfaces consume them in both browser and standalone modes; zero-inset devices naturally resolve them to zero. The standalone fallback probes every axis and provides landscape side insets when WebKit reports zero.

## Consequences

The mobile shell tracks the actually visible WebKit viewport, including rotation and keyboard transitions, without using `window.innerHeight` as its layout source.
