# Authentication Specification

## Overview

ai-or-die provides optional token-based authentication for both HTTP and WebSocket connections. Authentication is managed by two independent classes: a server-side `AuthManager` utility and a client-side `AuthManager` in the browser.

---

## Server-Side Auth

### AuthManager Class

Source: `src/utils/auth.js`

A utility class for token management, rate limiting, and Express middleware generation. While the class is available, the server (`src/server.js`) currently implements auth inline rather than delegating to this class.

#### Token Management

| Method | Description |
|--------|-------------|
| `generateToken()` | Generates a 32-byte random hex string via `crypto.randomBytes(32).toString('hex')` |
| `validateToken(token)` | Checks if `token` is in the internal `Set` |
| `addToken(token)` | Adds a token to the `Set` |
| `removeToken(token)` | Removes a token from the `Set` |
| `clearTokens()` | Clears all stored tokens |

#### Middleware Factory

`createMiddleware(requiredToken)` returns an Express middleware that:

1. If `requiredToken` is falsy, calls `next()` (no auth required).
2. Extracts the token from:
   - `Authorization: Bearer <token>` header, or
   - `?token=<token>` query parameter.
3. Compares against `requiredToken`.
4. Returns `401 Unauthorized` with `{ error: "Unauthorized", message: "Valid authentication token required" }` on mismatch.

#### WebSocket Validator

`createWebSocketValidator(requiredToken)` returns a function compatible with the `ws` library's `verifyClient` callback:

1. If `requiredToken` is falsy, returns `true` (no auth required).
2. Parses the URL from `info.req.url`.
3. Extracts `?token=` query parameter.
4. Returns `token === requiredToken`.

#### Rate Limiting

`rateLimit(identifier, maxRequests = 100, windowMs = 60000)`:

1. Tracks request timestamps per `identifier` (typically IP address).
2. Filters to requests within the current window.
3. Returns `false` if the limit is exceeded, `true` otherwise.
4. Pushes the current timestamp on success.

`createRateLimitMiddleware(maxRequests = 100, windowMs = 60000)` returns Express middleware that:
- Identifies the client by `req.ip || req.connection.remoteAddress`.
- Returns `429 Too Many Requests` with `retryAfter` header when the limit is hit.

`cleanupRateLimit()`:
- Removes entries older than 1 hour from the rate limiter `Map`.
- Should be called periodically to prevent memory growth.

---

### Server Auth Implementation

Source: `src/server.js` (inline in `setupExpress()`)

The server implements authentication directly rather than using the `AuthManager` class:

1. **Pre-auth endpoints** -- `/auth-status` and `/auth-verify` are registered before the auth middleware, making them accessible without a token.

2. **Auth middleware** -- Registered conditionally when `!this.noAuth && this.auth`:
   ```js
   const token = req.headers.authorization || req.query.token;
   if (token !== `Bearer ${this.auth}` && token !== this.auth) {
     return res.status(401).json({ error: 'Unauthorized' });
   }
   ```
   This accepts either:
   - `Authorization: Bearer <token>` header
   - `?token=<token>` query parameter (raw token, no Bearer prefix)
   - `Authorization: <token>` header (raw token, matched directly)

3. **WebSocket auth** -- The `verifyClient` callback on the `ws.Server`:
   ```js
   verifyClient: (info) => {
     if (!this.noAuth && this.auth) {
       const url = new URL(info.req.url, 'ws://localhost');
       const token = url.searchParams.get('token');
       return token === this.auth;
     }
     return true;
   }
   ```

---

### CLI Auth Flow

Source: `bin/cc-web.js`

| CLI Flag | Behavior |
|----------|----------|
| `--auth <token>` | Use the provided string as the auth token |
| `--disable-auth` | Set `noAuth = true`; no token is required |
| _(neither flag)_ | Auto-generate a random 10-character token using a charset that excludes ambiguous characters (`0`, `O`, `1`, `l`, `I`) |

The random token generator:
```js
const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
```
This produces tokens that are easy to read and transcribe (e.g., `kP7nVm3Qxt`).

The generated token is printed to the terminal with bold yellow ANSI formatting for visibility.

---

## Client-Side Auth

### AuthManager (Browser)

Source: `src/public/auth.js`

A global singleton instantiated as `window.authManager`.

#### Token Storage

Tokens are stored in `sessionStorage` under the key `cc-web-token`. This means:
- The token persists across page reloads within the same tab.
- The token is cleared when the tab/browser is closed.
- Each browser tab can have its own independent auth state.

#### Initialization Flow

`initialize()` is called on page load:

1. Calls `GET /auth-status` to check if auth is required.
2. If auth is required and no stored token exists, calls `showLoginPrompt()`.
3. If auth is required and a token exists, calls `POST /auth-verify` to validate it.
4. If validation fails, clears the stored token and shows the login prompt.
5. Returns `true` if authenticated (or auth not required), `false` if the login prompt was shown.

#### Login Prompt

`showLoginPrompt()` creates a full-screen overlay (`z-index: 10000`) with:
- A password input field for the access token.
- A submit button that calls `verifyToken()`.
- Error display for invalid tokens.
- Visual feedback during verification (input disabled, button text changes to "Authenticating...").
- On success: overlay is removed and `window.location.reload()` triggers full re-initialization.
- On failure: error message is shown, form is re-enabled.

#### Helper Methods

| Method | Description |
|--------|-------------|
| `getAuthHeaders()` | Returns `{ Authorization: "Bearer <token>" }` or empty object |
| `getWebSocketUrl(baseUrl)` | Appends `?token=<token>` (or `&token=<token>`) to the WebSocket URL |
| `logout()` | Clears `sessionStorage`, reloads the page |

#### Integration Points

- `ClaudeCodeWebInterface.authFetch(url, options)` merges `authManager.getAuthHeaders()` into every fetch request.
- WebSocket connections use `authManager.getWebSocketUrl()` to append the token to the connection URL.
- `SessionTabManager.loadSessions()` and `closeSession()` include auth headers via `window.authManager.getAuthHeaders()`.
