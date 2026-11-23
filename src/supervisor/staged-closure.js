'use strict';

// Staged-closure verifier for the user-level service tree.
//
// `service install` stages the supervisor entry plus an explicit file list into
// the stable base (~/.ai-or-die). That stage has NO node_modules, so a relative
// require() pointing at a file that was not copied is a hard MODULE_NOT_FOUND at
// the next Task start — hours after install, with no interactive user watching.
// PR #172 shipped exactly that: bin/supervisor-service.js requires
// ../src/supervisor/service-logging, which STAGED_FILES never copied.
//
// This module closes that class of bug: after staging, walk every require() in
// the staged tree and refuse to write a unit file while any relative specifier
// is unresolvable. Bare specifiers are only tolerated when explicitly allowed
// (koffi is optional by design — src/job-guard.js requires it lazily inside a
// try and degrades to taskkill when it is absent).
//
// Static analysis, not execution: requires inside comments and string literals
// must not count (a JSDoc example is not a dependency), while a genuine
// require inside a try/catch still must resolve — the file has to be there even
// if the failure is survivable.

const fs = require('fs');
const path = require('path');

// Node built-ins resolve without any node_modules tree, so they are never a
// staging defect. `module.isBuiltin` covers the `node:` prefix and both bare
// and prefixed spellings; `builtinModules` is the fallback for old runtimes.
const Module = require('module');
const BUILTINS = new Set(Module.builtinModules || []);
function isBuiltinSpec(spec) {
  const s = String(spec);
  if (s.startsWith('node:')) return true;
  if (typeof Module.isBuiltin === 'function') {
    try { return Module.isBuiltin(s); } catch (_) { /* fall through */ }
  }
  return BUILTINS.has(s);
}

// Bare specifiers that may legitimately be absent from the staged tree.
const DEFAULT_ALLOWED_BARE = new Set(['koffi']);

// Relative requires that are provably unreachable at runtime: the caller wraps
// them in try/catch with a hardcoded fallback, and the target is a build-time
// helper that is not part of the packaged closure. Matched against
// `<from>::<spec>` and `<from>::<resolved target>`.
const DEFAULT_ALLOW_MISSING = [
  // src/utils/sidecar-installer.js -> require('../../scripts/mesh-lock').ASSET_NAMES
  // inside a try/catch that falls back to a literal asset list.
  /^src[\\/]utils[\\/]sidecar-installer\.js::(\.\.\/\.\.\/)?scripts[\\/]mesh-lock(\.js)?$/,
];

// Tokenize just enough JavaScript to answer "which module specifiers does this
// file require?" without being fooled by decoys. Three shapes have to be
// handled or the audit is worse than useless:
//   - comments: a commented-out require is not a dependency,
//   - string literals: `"require('./x')"` inside documentation is not a
//     dependency either, but its contents used to be scanned and would block a
//     perfectly valid install,
//   - regex literals: `/['"]/` used to flip the scanner into a phantom string
//     state, after which real requires were skipped and quoted prose was
//     scanned instead.
//
// Strings and templates are consumed wholesale (their contents are never
// scanned) except for `${...}` in templates, which is real code. Regex-vs-
// division uses the standard "what came before" heuristic.
const REGEX_ALLOWED_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);
const IDENT_RE = /[A-Za-z_$]/;

function isRegexAllowed(lastToken) {
  if (!lastToken) return true;
  if (/^[A-Za-z_$][\w$]*$/.test(lastToken)) return REGEX_ALLOWED_AFTER_WORD.has(lastToken);
  // After a value-ending token a `/` is division, not a regex opener.
  return !/^[)\]}]$/.test(lastToken);
}

/**
 * Return the module specifiers a source string actually references, in source
 * order. Handles require(), require.resolve(), import() and static import.
 */
function extractSpecifiers(src) {
  const text = String(src);
  const n = text.length;
  const out = [];
  let i = 0;
  let lastToken = '';
  // True only while a bare `module` sits immediately before the dot being
  // scanned. `module.require('./x')` IS a module load, `obj.require('./x')` is
  // not, and both look identical to the property-access guard below.
  let moduleBeforeDot = false;

  /**
   * Skip an optional-chaining `?.` between a callee and its argument list.
   * `require?.('./x')` and `require.resolve?.('./x')` are real loads; without
   * this the scanner consumes the `?`, misses the `(`, and the dependency
   * never reaches the audit — a module the install refuses to stage.
   */
  function skipOptionalChaining(k) {
    if (text[k] === '?' && text[k + 1] === '.') {
      k += 2;
      while (k < n && /\s/.test(text[k])) k += 1;
    }
    return k;
  }

  function readStringLiteral() {
    const quote = text[i];
    i += 1;
    let value = '';
    while (i < n) {
      const c = text[i];
      if (c === '\\') { value += text[i + 1] || ''; i += 2; continue; }
      if (c === quote) { i += 1; return { value, closed: true }; }
      // An unterminated ' or " is contained to its own line: this is the
      // recovery that keeps one odd character from corrupting the rest of the
      // file. Templates may span lines legitimately.
      if (quote !== '`' && c === '\n') return { value, closed: false };
      if (quote === '`' && c === '$' && text[i + 1] === '{') {
        i += 2;
        readCode(true);
        continue;
      }
      value += c;
      i += 1;
    }
    return { value, closed: false };
  }

  function readRegexLiteral() {
    i += 1;
    let inClass = false;
    while (i < n) {
      const c = text[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') break;
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { i += 1; break; }
      i += 1;
    }
    while (i < n && /[a-z]/i.test(text[i])) i += 1;
  }

  /** Consume a call's argument list; record a plain string first argument. */
  function readCallArguments(kind) {
    while (i < n && /\s/.test(text[i])) i += 1;
    if (text[i] !== '(') { i += 1; return; }
    i += 1;
    while (i < n && /\s/.test(text[i])) i += 1;
    if (text[i] === "'" || text[i] === '"' || text[i] === '`') {
      const { value, closed } = readStringLiteral();
      if (closed && value) out.push({ spec: value, kind });
    }
    // Keep scanning the argument list instead of blind-skipping to the first
    // ')': that `)` may sit inside a string or a nested call, and resuming the
    // outer scan there used to hide every later require on the line. Scanning
    // also records a genuine nested `require('./x')` used as an argument.
    readCode(false, true);
  }

  function readCode(stopAtBrace, stopAtParen) {
    let depth = 0;
    while (i < n) {
      const c = text[i];
      const next = text[i + 1];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i += 1; continue; }
      if (c === '/' && next === '/') { while (i < n && text[i] !== '\n') i += 1; continue; }
      if (c === '/' && next === '*') {
        i += 2;
        while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
        i += 2;
        continue;
      }
      if (c === '/' && isRegexAllowed(lastToken)) { readRegexLiteral(); lastToken = '/re/'; moduleBeforeDot = false; continue; }
      if (c === "'" || c === '"' || c === '`') {
        readStringLiteral();
        lastToken = 'str';
        moduleBeforeDot = false;
        continue;
      }
      if (stopAtParen) {
        // Balance (), [] and {} so only the argument list's OWN closer ends the
        // scan: the ')' of a nested call, of an array literal or inside a
        // quoted path used to pass for the end of the call, and every require
        // after it was skipped.
        if (c === '(' || c === '[' || c === '{') { depth += 1; i += 1; lastToken = c; continue; }
        if (c === ')' || c === ']' || c === '}') {
          // A closer with nothing open means the source is not shaped as this
          // scanner assumes, so stop here rather than swallow the rest of the
          // file — the caller resumes the outer scan at the same point.
          if (depth === 0) {
            if (c === ')') i += 1;
            return;
          }
          depth -= 1;
          i += 1;
          lastToken = c;
          continue;
        }
      }
      if (c === '{') { depth += 1; i += 1; lastToken = '{'; continue; }
      if (c === '}') {
        if (stopAtBrace && depth === 0) { i += 1; return; }
        depth = Math.max(0, depth - 1);
        i += 1;
        lastToken = '}';
        continue;
      }
      if (IDENT_RE.test(c)) {
        let j = i;
        while (j < n && /[\w$]/.test(text[j])) j += 1;
        const word = text.slice(i, j);
        const prev = lastToken;
        // Reads the flag BEFORE resetting it: the identifier in front of the
        // dot is what decides whether `.require` is a load.
        const loadViaModule = moduleBeforeDot && word === 'require' && prev === '.';
        // Only a bare `module` roots a load, so `x.module.require` stays ignored.
        moduleBeforeDot = word === 'module' && prev !== '.';
        i = j;
        lastToken = word;
        // Skip property access: obj.require === fn is not a module load.
        if (prev === '.' && !loadViaModule) continue;
        if (word === 'import') { readCallArguments('import'); lastToken = 'import'; continue; }
        if (word === 'from' && prev !== '.') {
          // static import: `import x from './y'`
          while (i < n && /\s/.test(text[i])) i += 1;
          if (text[i] === "'" || text[i] === '"') {
            const { value, closed } = readStringLiteral();
            if (closed && value) out.push({ spec: value, kind: 'import' });
            lastToken = 'str';
          }
          continue;
        }
        if (word === 'require') {
          // require.resolve('./x') / require('./x') / module.require('./x')
          let k = i;
          while (k < n && /\s/.test(text[k])) k += 1;
          let kind = 'require';
          if (text[k] === '.') {
            const rest = text.slice(k, k + 8);
            if (rest === '.resolve') { k += 8; kind = 'resolve'; } else { continue; }
            while (k < n && /\s/.test(text[k])) k += 1;
          }
          i = skipOptionalChaining(k);
          readCallArguments(kind);
          lastToken = ')';
          continue;
        }
        continue;
      }
      // Any token other than `.` (or the `?` of `?.`) breaks the
      // `module`-then-dot adjacency the flag describes.
      if (c !== '.' && c !== '?') moduleBeforeDot = false;
      lastToken = c;
      i += 1;
    }
  }

  readCode(false);
  return out;
}

/** Backwards-compatible alias: the specifier list, deduplicated by spec. */
function listRequires(src) {
  const seen = new Set();
  const out = [];
  for (const { spec } of extractSpecifiers(src)) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    out.push({ spec, bare: !spec.startsWith('.') && !path.isAbsolute(spec) });
  }
  return out;
}

/**
 * The source with comments removed and everything else (strings, templates,
 * regex literals) left EXACTLY as written. Test/diagnostic helper only — the
 * audit itself uses extractSpecifiers(). Blanking string bodies here would make
 * `stripComments(src).includes('./real')` false for a real require and turn any
 * assertion built on this helper into a tautology.
 */
function stripComments(src) {
  const text = String(src);
  const out = [];
  let i = 0;
  const n = text.length;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j += 1;
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j += 1;
      out.push(blank(text.slice(i, Math.min(n, j + 2))));
      i = Math.min(n, j + 2);
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      // Copy the literal verbatim, honouring escapes and ${...} nesting.
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === c) { j += 1; break; }
        if (c !== '`' && text[j] === '\n') break;
        j += 1;
      }
      out.push(text.slice(i, j));
      i = j;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join('');
}

/**
 * Resolve a relative specifier the way Node would, restricted to the
 * extensions a staged tree can actually contain.
 * Returns the resolved absolute path or null.
 */
function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.cjs`,
    // The staged tree carries a minimal package.json plus native addons, and
    // both load fine without node_modules; omitting them reported a present
    // file as missing and refused a valid install.
    `${base}.json`,
    `${base}.node`,
    path.join(base, 'index.js'),
    path.join(base, 'index.cjs'),
  ];
  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
    } catch (_) { /* ignore */ }
  }
  return null;
}

function walkJsFiles(rootDir, skipDirs = new Set(['node_modules', '.git'])) {
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        stack.push(full);
      } else if (e.isFile() && /\.(c?js)$/.test(e.name)) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Verify that every relative require reachable from `entryFile` resolves
 * inside the staged tree.
 *
 * @param {string} entryFile absolute path of the staged entry point
 * @param {object} [options]
 * @param {Set<string>} [options.allowedBare] bare specifiers that may be absent
 * @param {string} [options.rootDir] tree root; defaults to the entry's base dir
 * @returns {{checked: number, missing: Array<{from: string, spec: string, resolved: string}>,
 *            bare: Array<{from: string, spec: string}>, allowedBare: string[]}}
 */
function auditClosure(entryFile, options = {}) {
  const allowedBare = options.allowedBare || DEFAULT_ALLOWED_BARE;
  const allowMissing = [
    ...DEFAULT_ALLOW_MISSING,
    ...(Array.isArray(options.allowMissing) ? options.allowMissing : []),
  ];
  const entry = path.resolve(entryFile);
  const rootDir = options.rootDir
    ? path.resolve(options.rootDir)
    : path.resolve(path.dirname(entry), '..');
  const missing = [];
  const bare = [];
  const visited = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch (_) {
      missing.push({ from: file, spec: '(unreadable)', resolved: file });
      continue;
    }
    for (const { spec, bare: isBare } of listRequires(src)) {
      if (isBare) {
        if (isBuiltinSpec(spec) || allowedBare.has(spec)) continue;
        bare.push({ from: file, spec });
        continue;
      }
      if (path.isAbsolute(spec)) continue; // absolute requires are the caller's business
      const resolved = resolveRelative(file, spec);
      if (!resolved) {
        const fromRel = formRelFile(rootDir, file);
        const resolvedRel = formRelFile(rootDir, path.resolve(path.dirname(file), spec));
        // Explicitly-tolerated gaps (build-time-only helpers reached behind a
        // lazy require in a file that is otherwise stageable). Matched against
        // `<from>::<raw spec>` and `<from>::<resolved target>` so callers can
        // write whichever form reads better.
        const tolerated = allowMissing.some(
          (re) => re.test(`${fromRel}::${spec}`) || re.test(`${fromRel}::${resolvedRel}`)
        );
        if (tolerated) continue;
        missing.push({ from: fromRel, spec, resolved: resolvedRel });
        continue;
      }
      queue.push(resolved);
    }
  }
  return {
    checked: visited.size,
    missing,
    bare,
    allowedBare: Array.from(allowedBare),
  };
}

function formRelFile(rootDir, file) {
  const rel = path.relative(rootDir, file);
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : file;
}

function formatAuditFailure(audit) {
  const lines = [];
  if (audit.missing.length) {
    lines.push('unresolvable relative require(s) in the staged tree:');
    for (const m of audit.missing) {
      lines.push(`  ${m.from} -> ${m.spec} (expected ${m.resolved})`);
    }
  }
  if (audit.bare.length) {
    lines.push(
      `bare module(s) that cannot load in the staged tree (allowed: ${audit.allowedBare.join(', ') || 'none'}):`
    );
    for (const b of audit.bare) lines.push(`  ${b.from} -> ${b.spec}`);
  }
  return lines.join('\n');
}

/**
 * Throwing wrapper used by the installer before any unit file is written.
 * Returns the audit on success.
 */
function assertStagedClosure(entryFile, options = {}) {
  const audit = auditClosure(entryFile, options);
  if (audit.missing.length || audit.bare.length) {
    const err = new Error(
      'service install: staged tree is incomplete and would fail to boot — '
      + 'reinstall the ai-or-die package and retry\n'
      + formatAuditFailure(audit)
    );
    err.code = 'ESTAGEDCLOSURE';
    err.audit = audit;
    throw err;
  }
  return audit;
}

module.exports = {
  auditClosure,
  assertStagedClosure,
  extractSpecifiers,
  listRequires,
  resolveRelative,
  stripComments,
  walkJsFiles,
  formatAuditFailure,
  isBuiltinSpec,
  DEFAULT_ALLOWED_BARE,
  DEFAULT_ALLOW_MISSING,
};
