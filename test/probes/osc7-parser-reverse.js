// test/probes/osc7-parser-reverse.js — Probe 5b for ADR-0021.
//
// Cross-checks the OSC 7 URI forms our pwsh shim would emit (probe 5)
// against the server-side decoder (src/osc7-parser.js, ADR-0019). If the
// parser yields the expected platform-native paths, the round-trip is
// closed and we know the wrapper design is wire-compatible with the
// existing bridge.
//
// Standalone — does NOT touch src/ or production code paths. Invoked
// from .github/workflows/probe-pwsh.yml on the windows-latest runner.
// Argv is a list of percent-encoded URI body paths (forward-slash form,
// post-EscapeUriString); the script wraps each into the full OSC 7
// envelope `\x1b]7;file://HOSTNAME<body>\x07` and feeds it to the
// parser.

'use strict';

const Osc7Parser = require('../../src/osc7-parser');

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error('Usage: node osc7-parser-reverse.js <uri-body> [<uri-body>...]');
  process.exit(2);
}

const results = [];
for (const body of inputs) {
  // body is post-EscapeUriString forward-slash form. For UNC paths the
  // pwsh shim emits `//server/share/foo` (the leading `//` collapses to
  // a single slash inside the URI body because file:// + // would parse
  // as the host segment). We mirror what the shim would put on the
  // wire: `\x1b]7;file://HOSTNAME` + (body ? body starting with / : prepend /) + `\x07`.
  let wireBody;
  if (body.startsWith('//')) {
    // UNC — body is already `//server/share/foo`. The URI form is
    // `file://server/share/foo` (one slash kept as URI separator).
    wireBody = body.slice(1); // → `/server/share/foo` — host parsed from URI
  } else {
    wireBody = body.startsWith('/') ? body : '/' + body;
  }
  const wire = '\x1b]7;file://HOSTNAME' + wireBody + '\x07';
  const parser = new Osc7Parser();
  let decoded;
  try {
    decoded = parser.feed(wire);
  } catch (err) {
    decoded = { ERROR: err && err.message };
  }
  results.push({
    inputBody: body,
    wirePrintable: wire.replace(/\x1b/g, '\\e').replace(/\x07/g, '\\a'),
    decoded,
  });
}

console.log(JSON.stringify(results, null, 2));
