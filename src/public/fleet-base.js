'use strict';

// Fleet path-mode base helper (loaded first, before all other app scripts).
//
// The same bundle works at root `/` (standalone, --tunnel) and under an
// arbitrary fleet path `/m/<id>/` with zero startup config: the prefix is
// derived per page-load from `location.pathname`. Server-side, Express strips
// the same prefix before routing (see setupExpress), so every API/WS/static
// route dual-serves.
//
// Usage: `withBase('/api/sessions/list')` -> `/m/<id>/api/sessions/list`
// under fleet, unchanged `/api/sessions/list` at root. WS: append the prefix
// to the host part: `proto + '//' + host + getBasePrefix() + '/?sessionId='`.
(function (global) {
  var FLEET_PREFIX_RE = /^\/m\/[^/?#]+/;

  function getBasePrefix() {
    try {
      var m = FLEET_PREFIX_RE.exec(String((global.location || {}).pathname || ''));
      return m ? m[0] : '';
    } catch (_e) {
      return '';
    }
  }

  function withBase(path) {
    var p = String(path || '');
    // Only rewrite root-absolute app paths; leave relative URLs, hashes,
    // external URLs and already-prefixed paths untouched.
    if (p.charAt(0) !== '/' || p.charAt(1) === '/') return p;
    var base = getBasePrefix();
    if (!base) return p;
    if (p === base || p.indexOf(base + '/') === 0) return p;
    return base + p;
  }

  // Auth/token storage must be scoped per prefix: two machines on one fleet
  // origin would otherwise share (and overwrite) one sessionStorage token.
  function scopedKey(key) {
    var base = getBasePrefix();
    return base ? String(key) + ':' + base : String(key);
  }

  global.FleetBase = {
    getBasePrefix: getBasePrefix,
    withBase: withBase,
    scopedKey: scopedKey,
  };
  // Convenience globals (classic scripts, no modules in this app).
  global.getBasePrefix = getBasePrefix;
  global.withBase = withBase;
  global.scopedAuthKey = scopedKey;
})(typeof window !== 'undefined' ? window : globalThis);
