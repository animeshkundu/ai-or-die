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
//   The `?base=` query parameter is validated against an allowlist of CDN
//   hosts before importScripts. This stops the Worker URL from becoming a
//   path-traversal sink: an attacker who could spoof the loader options
//   still couldn't cause this shim to importScripts an arbitrary origin.
//   The `?label=` parameter is informational only (for DevTools naming).

(function () {
  'use strict';

  var ALLOWED_HOSTS = [
    'cdn.jsdelivr.net',
    'cdnjs.cloudflare.com',
    'unpkg.com',
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

  // Force trailing slash so concatenation below is well-formed.
  if (baseUrl.charAt(baseUrl.length - 1) !== '/') baseUrl += '/';

  var parsed;
  try { parsed = new URL(baseUrl); }
  catch (_) { fail('invalid base URL'); }

  if (parsed.protocol !== 'https:') fail('base URL must be https');
  if (ALLOWED_HOSTS.indexOf(parsed.hostname) === -1) {
    fail('base URL host "' + parsed.hostname + '" not in allowlist');
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
