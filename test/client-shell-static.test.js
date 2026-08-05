'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'src', 'public');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function authoredFiles(extensions) {
  return walk(publicDir).filter((file) => {
    return extensions.some((extension) => file.endsWith(extension))
      && !file.includes(`${path.sep}vendor${path.sep}`);
  });
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} should be discoverable`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(open + 1, index);
  }
  assert.fail(`${signature} should have a closing brace`);
}

describe('client shell static contracts', function () {
  it('keeps terminal resize ownership in FitCoordinator', function () {
    const offenders = authoredFiles(['.js'])
      .filter((file) => path.basename(file) !== 'fit-coordinator.js')
      .flatMap((file) => fs.readFileSync(file, 'utf8').split('\n')
        .map((line, index) => ({ file, line, index: index + 1 }))
        .filter(({ line }) => /\bterminal\.resize\s*\(|\bfitAddon\.fit\s*\(/.test(line)));
    assert.deepStrictEqual(offenders, []);
  });

  it('has no load-bearing plain vh units', function () {
    const offenders = authoredFiles(['.css', '.js', '.html'])
      .flatMap((file) => fs.readFileSync(file, 'utf8').split('\n')
        .map((line, index) => ({ file, line, index: index + 1 }))
        .filter(({ line }) => /(^|[^a-z])\d+(?:\.\d+)?vh\b/.test(line)));
    assert.deepStrictEqual(offenders, []);
  });

  it('routes authored CSS motion through tokens', function () {
    const offenders = authoredFiles(['.css', '.js', '.html']).flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      const declarations = /(?:transition|animation)(?:-[\w-]+)?\s*:\s*([^;]+)/g;
      const results = [];
      let match;
      while ((match = declarations.exec(source))) {
        const authoredValue = match[1].replace(/var\([^)]*\)/g, '');
        const hasLiteralDuration = /\b(?:\d*\.\d+|\d+)(?:ms|s)\b/.test(authoredValue);
        const hasLiteralEasing = /\bcubic-bezier\s*\(|\bsteps\s*\(|\b(?:linear|ease|ease-in|ease-out|ease-in-out)\b/.test(authoredValue);
        if (hasLiteralDuration || hasLiteralEasing) {
          results.push({ file, line: match[0], index: lineNumber(source, match.index) });
        }
      }
      return results;
    });
    assert.deepStrictEqual(offenders, []);
  });

  it('keeps binary ingress limited to queueing and scheduling', function () {
    const source = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
    const body = methodBody(source, 'handleBinaryOutput(data)');
    assert.ok(!/decode|markSessionActivity|setTimeout|queueMicrotask|snapshotCache|planDetector/.test(body));
  });
});
