# Mesh WebSocket Authorization Header Auth

**Date:** 2026-07-08
**Files:** `src/server.js`, `test/ws-auth-header.test.js`, `docs/specs/mesh.md`
**Tests:** `test/ws-auth-header.test.js`

## Problem

The mesh sidecar injects `Authorization: Bearer <token>` on the tailnet-to-loopback hop for both HTTP requests and WebSocket upgrade requests. HTTP routes already accepted either that bearer header or `?token=`, but the WebSocket server's `verifyClient` checked only the query token.

A browser that reached an authenticated instance through the sidecar without a `?token=` query string could load HTTP routes but fail to open the WebSocket.

## Fix

WebSocket authentication now mirrors the HTTP middleware: when auth is enabled, a socket upgrade is accepted if either `?token=<token>` matches or `Authorization: Bearer <token>` matches. The query-token path remains supported, and `--disable-auth` still accepts unauthenticated sockets.

## Verification

`test/ws-auth-header.test.js` starts real loopback servers on ephemeral ports and covers bearer-header success, wrong-header rejection, query-token regression, and auth-disabled success.
