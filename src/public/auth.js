// Authentication module for ai-or-die

// ---------------------------------------------------------------------------
// Module-level helpers — exported on `window` AND on `module.exports` (for
// Node-side unit tests). Pure functions where possible so the URL-token
// consumption + log sanitisation can be unit-tested without spinning up
// JSDOM. Per QA #13 (auth-on journey), these close three P1 token leaks:
//   - finding #2: the CLI prints `?token=…` URLs that the client ignored.
//   - finding #3: the same `?token=…` lingered in the address bar.
//   - finding #4: the SW registration error log included a stack trace
//     containing the URL with the token.
// ---------------------------------------------------------------------------

/**
 * Strip every occurrence of `?token=…` / `&token=…` from a string and
 * replace with `<redacted>`. Defends against:
 *   - Bearer tokens echoed via `Authorization: Bearer xxx` headers.
 *   - URLs in error messages / stack traces (the `at` lines from native
 *     errors include the originating URL — that's how finding #4 leaked).
 *   - Any future log site that stringifies a request URL.
 *
 * Pure — accepts any value, coerces to string. Safe to call from
 * arbitrary log handlers.
 */
function sanitizeForLog(s) {
  if (s == null) return '';
  return String(s)
    // ?token= or &token= in any URL-shaped substring.
    .replace(/([?&])token=[^&\s'"`)\\]+/gi, '$1token=<redacted>')
    // `Bearer <token>` in serialised header dumps.
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, '$1<redacted>');
}

/**
 * Read a `?token=` URL parameter (if any) and strip it from the address
 * bar so it doesn't leak into screenshots, the Referer header, or
 * server access logs. Returns the extracted token (or null when absent).
 *
 * Always strips the param, even when absent — no-op in that case. The
 * strip uses `history.replaceState` so the back button isn't polluted
 * with an extra entry.
 *
 * Browser-only (no-op when `window` / `URLSearchParams` aren't
 * available — e.g. when this module is loaded under Node for testing).
 */
function extractAndStripUrlToken() {
  if (typeof window === 'undefined' || !window.location) return null;
  if (typeof URLSearchParams === 'undefined') return null;
  var params;
  try { params = new URLSearchParams(window.location.search || ''); }
  catch (_) { return null; }
  var t = params.get('token');
  // Always strip — even when absent we want a deterministic post-condition
  // (no `?token=` in the URL bar).
  try {
    if (t != null) {
      params.delete('token');
      var qs = params.toString();
      var newUrl = window.location.pathname + (qs ? '?' + qs : '') +
        (window.location.hash || '');
      if (window.history && typeof window.history.replaceState === 'function') {
        window.history.replaceState({}, '', newUrl);
      }
    }
  } catch (_) { /* best-effort URL hygiene — never throw */ }
  return t || null;
}

class AuthManager {
    constructor() {
        this.token = (typeof sessionStorage !== 'undefined')
          ? sessionStorage.getItem('cc-web-token')
          : null;
        this.authRequired = false;
    }

    async checkAuthStatus() {
        try {
            const response = await fetch('/auth-status');
            if (!response.ok) {
                throw new Error('Failed to check auth status');
            }
            const data = await response.json();
            this.authRequired = data.authRequired;
            return data;
        } catch (error) {
            console.error('Failed to check auth status:', sanitizeForLog(error && error.message));
            // Assume auth is required if we can't check - safer default
            this.authRequired = true;
            return { authRequired: true, authenticated: false };
        }
    }

    async verifyToken(token) {
        try {
            const response = await fetch('/auth-verify', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ token })
            });

            const data = await response.json();
            if (data.valid) {
                this.token = token;
                if (typeof sessionStorage !== 'undefined') {
                    sessionStorage.setItem('cc-web-token', token);
                }
            }
            return data.valid;
        } catch (error) {
            console.error('Failed to verify token:', sanitizeForLog(error && error.message));
            return false;
        }
    }

    showLoginPrompt() {
        console.log('[Auth] Showing login prompt...');
        
        // Remove any existing auth overlay
        const existingOverlay = document.getElementById('auth-overlay');
        if (existingOverlay) {
            console.log('[Auth] Removing existing overlay');
            existingOverlay.remove();
        }

        const overlay = document.createElement('div');
        overlay.id = 'auth-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.95);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: var(--z-auth, 9999);
        `;

        const loginForm = document.createElement('div');
        loginForm.style.cssText = `
            background: var(--bg-secondary, #1c2128);
            border: 1px solid var(--border-color, #30363d);
            border-radius: 12px;
            padding: 32px;
            max-width: 400px;
            width: 90%;
            box-shadow: 0 10px 50px rgba(0, 0, 0, 0.5);
        `;

        loginForm.innerHTML = `
            <h2 style="color: var(--text-primary, #f0f6fc); margin: 0 0 8px 0; font-family: 'Inter', system-ui, -apple-system, Segoe UI, Roboto, 'JetBrains Mono', monospace; display: flex; align-items: center; gap: 8px;">
                <span class="icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="10" width="18" height="11" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/></svg></span>
                Authentication Required
            </h2>
            <p style="color: var(--text-secondary, #8b949e); margin: 0 0 24px 0; font-size: 14px;">
                This ai-or-die instance requires authentication.
            </p>
            <form id="auth-form">
                <div style="margin-bottom: 16px;">
                    <label for="auth-token" style="display: block; color: var(--text-secondary, #8b949e); margin-bottom: 8px; font-size: 14px;">
                        Access Token
                    </label>
                    <input 
                        type="password" 
                        id="auth-token" 
                        placeholder="Enter your access token"
                        style="
                            width: 100%;
                            padding: 10px 12px;
                            background: var(--bg-primary, #0d1117);
                            border: 1px solid var(--border-color, #30363d);
                            border-radius: 6px;
                            color: var(--text-primary, #f0f6fc);
                            font-family: 'Inter', system-ui, -apple-system, Segoe UI, Roboto, 'JetBrains Mono', monospace;
                            font-size: 14px;
                            box-sizing: border-box;
                        "
                        autofocus
                        required
                    />
                </div>
                <div id="auth-error" style="color: #f85149; margin-bottom: 16px; font-size: 14px; display: none;"></div>
                <button 
                    type="submit"
                    style="
                        width: 100%;
                        padding: 10px 16px;
                        background: var(--accent);
                        color: white;
                        border: none;
                        border-radius: 6px;
                        font-family: 'Inter', system-ui, -apple-system, Segoe UI, Roboto, 'JetBrains Mono', monospace;
                        font-size: 14px;
                        font-weight: 500;
                        cursor: pointer;
                        transition: opacity 0.2s;
                    "
                    onmouseover="this.style.opacity='0.9'"
                    onmouseout="this.style.opacity='1'"
                >
                    Authenticate
                </button>
            </form>
            <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border-color, #30363d);">
                <p style="color: var(--text-secondary, #8b949e); font-size: 12px; margin: 0;">
                    The access token was set when starting the server with the <code style="background: var(--bg-primary, #0d1117); padding: 2px 4px; border-radius: 3px;">--auth</code> flag.
                </p>
            </div>
        `;

        overlay.appendChild(loginForm);
        document.body.appendChild(overlay);

        // Handle form submission
        const form = document.getElementById('auth-form');
        const tokenInput = document.getElementById('auth-token');
        const errorDiv = document.getElementById('auth-error');

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const token = tokenInput.value.trim();
            if (!token) {
                errorDiv.textContent = 'Please enter a token';
                errorDiv.style.display = 'block';
                return;
            }

            // Disable form while checking
            tokenInput.disabled = true;
            form.querySelector('button').disabled = true;
            form.querySelector('button').textContent = 'Authenticating...';

            const valid = await this.verifyToken(token);
            
            if (valid) {
                // Success - remove overlay and reload the app
                overlay.remove();
                window.location.reload();
            } else {
                // Failed - show error
                errorDiv.textContent = 'Invalid token. Please try again.';
                errorDiv.style.display = 'block';
                
                // Re-enable form
                tokenInput.disabled = false;
                tokenInput.value = '';
                tokenInput.focus();
                form.querySelector('button').disabled = false;
                form.querySelector('button').textContent = 'Authenticate';
            }
        });

        // Focus the input
        tokenInput.focus();
    }

    getAuthHeaders() {
        if (!this.token) return {};
        return {
            'Authorization': `Bearer ${this.token}`
        };
    }

    /**
     * Return the current token (or null when none is set). Mirrors the
     * shape app.js's FindPanel + generic-drop wiring expects — both call
     * `window.authManager.getToken()` to populate their `getAuthToken`
     * callbacks so request URLs carry `?token=` under `--auth` mode.
     *
     * Added in response to QA #17: previously the method didn't exist
     * and the callbacks returned undefined, so request URLs were token-
     * less and the server 401'd — Cmd-P returned 0 results and generic
     * drop uploads broke under auth. Default mode hid it (tokenless
     * requests are tolerated there).
     */
    getToken() {
        return this.token || null;
    }

    /**
     * Append the auth token as a `?token=` query param.
     *
     * Use this for asset URLs that the browser fetches WITHOUT being able
     * to attach custom headers — `<img src>`, `<iframe src>`, PDF.js
     * `getDocument({url})`, and any other browser-driven fetch where
     * `getAuthHeaders()` can't be threaded through. The auth middleware
     * accepts both `Authorization: Bearer <t>` and `?token=<t>` so this is
     * the canonical fallback when the header path isn't available.
     *
     * Trade-off: query-param tokens can leak into server access logs and
     * `Referer` headers. The download endpoint mitigates with
     * `Cache-Control: no-store` + `X-Content-Type-Options: nosniff`. A
     * future hardening pass should migrate to short-lived HMAC-signed
     * file-scoped tokens; tracked separately.
     */
    appendAuthToUrl(url) {
        if (!this.token) return url;
        const separator = url.includes('?') ? '&' : '?';
        return `${url}${separator}token=${encodeURIComponent(this.token)}`;
    }

    getWebSocketUrl(baseUrl) {
        if (!this.token) return baseUrl;
        const separator = baseUrl.includes('?') ? '&' : '?';
        return `${baseUrl}${separator}token=${encodeURIComponent(this.token)}`;
    }

    logout() {
        this.token = null;
        sessionStorage.removeItem('cc-web-token');
        window.location.reload();
    }

    async initialize() {
        console.log('[Auth] Initializing auth manager...');
        console.log('[Auth] Current token:', this.token ? 'exists' : 'none');

        // Per QA #13 finding #2 + #3: read a `?token=` URL parameter (if
        // any) and STRIP it from the address bar before we do anything
        // else. The strip happens regardless of whether auth ends up
        // being required — query strings leak via screenshots, the
        // Referer header, server access logs, and screen-shares.
        const urlToken = extractAndStripUrlToken();
        if (urlToken) console.log('[Auth] URL token present (stripped from address bar)');

        const status = await this.checkAuthStatus();
        console.log('[Auth] Auth status:', status);

        if (status.authRequired) {
            // URL token wins over the sessionStorage token — when both
            // are present, the URL one is fresher (it just came from the
            // CLI), and the SS one might be stale across server restarts.
            if (urlToken) {
                console.log('[Auth] Verifying URL token...');
                const urlValid = await this.verifyToken(urlToken);
                if (urlValid) {
                    console.log('[Auth] URL token valid — auto-authenticated');
                    return true;
                }
                console.log('[Auth] URL token invalid — falling through to sessionStorage / login');
            }
            if (this.token) {
                console.log('[Auth] Auth required and SS token exists — verifying...');
                const valid = await this.verifyToken(this.token);
                if (valid) {
                    console.log('[Auth] SS token valid');
                    return true;
                }
                console.log('[Auth] SS token invalid - showing login prompt');
                this.token = null;
                if (typeof sessionStorage !== 'undefined') {
                    sessionStorage.removeItem('cc-web-token');
                }
            }
            console.log('[Auth] Auth required but no valid token - showing login prompt');
            this.showLoginPrompt();
            return false;
        }

        console.log('[Auth] Authentication successful or not required');
        return true;
    }
}

// Expose helpers on the class for callers that need them statically (the
// SW registration in index.html, future log sites, unit tests).
AuthManager.sanitizeForLog = sanitizeForLog;
AuthManager.extractAndStripUrlToken = extractAndStripUrlToken;

// Create global auth manager instance + expose the class itself + the
// bare helpers for non-class callers (the SW registration in
// index.html lives outside class scope).
if (typeof window !== 'undefined') {
    window.AuthManager = AuthManager;
    window.authManager = new AuthManager();
    window.sanitizeAuthLog = sanitizeForLog;
}

// Node-side export for unit tests. Module-level helpers + the class.
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        AuthManager: AuthManager,
        sanitizeForLog: sanitizeForLog,
        extractAndStripUrlToken: extractAndStripUrlToken,
    };
}
