// monaco-worker-shim.js — same-origin Web Worker that bootstraps Monaco's
// worker bundle from a CDN.
//
// Why this exists (per ADR-0016):
//   The browser blocks `new Worker(<cross-origin URL>)`. Monaco's language
//   workers (editor, json, css, html, typescript) live on jsdelivr alongside
//   the main editor bundle. This shim is served from our own origin and
//   delegates to the CDN via importScripts, which IS allowed across origins.
//
// Wire-up (set in src/public/file-viewer-monaco.js before Monaco loads):
//   self.MonacoEnvironment = {
//     getWorker(workerId, label) {
//       return new Worker('/vendor/monaco-worker-shim.js?base=...&label=...');
//     }
//   };
//
// Security:
//   The `?base=` query parameter is matched against an EXACT-PREFIX allowlist
//   of full Monaco base URLs (host + path + version + trailing slash). A
//   host-only allowlist is insufficient — `cdn.jsdelivr.net/npm/<any-pkg>/`
//   serves arbitrary npm-published code, which would give attacker-published
//   packages same-origin Worker execution if we accepted any path under the
//   allowlisted host. Exact-string match (after trailing-slash normalisation)
//   is the right granularity: there is exactly one valid base per Monaco
//   version, and bumping Monaco forces an intentional, reviewable update to
//   this list.
//
//   Keep this list in sync with MONACO_BASE in src/public/file-viewer-monaco.js;
//   test/file-viewer-monaco.test.js asserts the two stay aligned.
//
//   The `?label=` parameter is informational only (for DevTools naming).

(function () {
  'use strict';

  // Exact-prefix allowlist. One entry per supported Monaco version. Each
  // entry MUST end with `/` so the trailing-slash normalisation below can
  // match the bare `?base=` value.
  var ALLOWED_BASES = [
    'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/',
  ];

  function fail(reason) {
    // Workers can't show UI; throw so the host page hears `error` events.
    throw new Error('monaco-worker-shim: ' + reason);
  }

  var here;
  try { here = new URL(self.location.href); }
  catch (_) { fail('cannot parse worker URL'); }

  var baseUrl = here.searchParams.get('base');
  if (!baseUrl) fail('missing base parameter');

  // Force trailing slash so concatenation below — and the allowlist match —
  // are well-formed regardless of how the caller spelled the param.
  if (baseUrl.charAt(baseUrl.length - 1) !== '/') baseUrl += '/';

  // Defence-in-depth: also reject anything that doesn't parse as a URL or
  // doesn't use https. The exact-prefix match below would already catch
  // these (they wouldn't match), but failing earlier with a clearer error
  // simplifies debugging genuine misconfigurations.
  var parsed;
  try { parsed = new URL(baseUrl); }
  catch (_) { fail('invalid base URL'); }
  if (parsed.protocol !== 'https:') fail('base URL must be https');

  // The actual gate. Equality, not host-membership.
  if (ALLOWED_BASES.indexOf(baseUrl) === -1) {
    fail('base URL "' + baseUrl + '" not in allowlist');
  }

  // Hand the base back to Monaco's worker bootstrap so it can locate
  // language-specific worker shards (json.worker, css.worker, etc.) at
  // <base>vs/...
  self.MonacoEnvironment = { baseUrl: baseUrl };

  // Load Monaco's canonical worker dispatcher. It picks a language service
  // based on the `label` field of the create message that the host page
  // sends after Worker construction — we don't dispatch by label here.
  importScripts(baseUrl + 'vs/base/worker/workerMain.js');
})();
