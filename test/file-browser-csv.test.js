// Tests for the RFC-4180-ish CSV parser used by FilePreviewPanel._renderCsv
// (per task #5). Pure JS, browser-DOM-free — exercises the parsing surface
// only. Render-side behaviour (IntersectionObserver virtualisation, click-
// to-sort, sticky header) is covered by the Playwright e2e suite (#11).

const assert = require('assert');
const { parseCsvLine, detectColumnIsNumeric } = require('../src/public/file-browser');

describe('parseCsvLine (RFC-4180-ish)', function () {

  describe('unquoted fields', function () {
    it('splits a simple comma row', function () {
      assert.deepStrictEqual(parseCsvLine('a,b,c', ','), ['a', 'b', 'c']);
    });

    it('preserves whitespace inside cells', function () {
      assert.deepStrictEqual(parseCsvLine('hello world , foo', ','),
        ['hello world ', ' foo']);
    });

    it('handles empty fields', function () {
      assert.deepStrictEqual(parseCsvLine('a,,c', ','), ['a', '', 'c']);
    });

    it('handles a single trailing empty field', function () {
      assert.deepStrictEqual(parseCsvLine('a,b,', ','), ['a', 'b', '']);
    });

    it('handles a single leading empty field', function () {
      assert.deepStrictEqual(parseCsvLine(',a,b', ','), ['', 'a', 'b']);
    });

    it('handles a single-cell line', function () {
      assert.deepStrictEqual(parseCsvLine('hello', ','), ['hello']);
    });

    it('returns no cells for an empty line', function () {
      assert.deepStrictEqual(parseCsvLine('', ','), []);
    });
  });

  describe('quoted fields', function () {
    it('strips surrounding quotes', function () {
      assert.deepStrictEqual(parseCsvLine('"hello",world', ','), ['hello', 'world']);
    });

    it('preserves separator inside quotes', function () {
      assert.deepStrictEqual(parseCsvLine('"a,b","c"', ','), ['a,b', 'c']);
    });

    it('preserves whitespace and special chars inside quotes', function () {
      assert.deepStrictEqual(parseCsvLine('"hello, world!","x"', ','),
        ['hello, world!', 'x']);
    });

    it('handles empty quoted field', function () {
      assert.deepStrictEqual(parseCsvLine('"",b', ','), ['', 'b']);
    });

    it('handles escaped double quotes ("")', function () {
      // Per RFC 4180: a literal " inside a quoted field is "".
      assert.deepStrictEqual(parseCsvLine('"she said ""hi""",b', ','),
        ['she said "hi"', 'b']);
    });

    it('handles back-to-back escaped quotes', function () {
      assert.deepStrictEqual(parseCsvLine('"""""",b', ','), ['""', 'b']);
    });

    it('handles mix of quoted and unquoted fields', function () {
      assert.deepStrictEqual(parseCsvLine('a,"b,c",d,"e"', ','),
        ['a', 'b,c', 'd', 'e']);
    });
  });

  describe('alternate separators', function () {
    it('handles tab-separated values', function () {
      assert.deepStrictEqual(parseCsvLine('a\tb\tc', '\t'), ['a', 'b', 'c']);
    });

    it('handles tab-separated with embedded comma', function () {
      // No need to quote the comma when separator is tab.
      assert.deepStrictEqual(parseCsvLine('a,b\tc,d', '\t'), ['a,b', 'c,d']);
    });

    it('handles tab-separated with quoted tabs', function () {
      assert.deepStrictEqual(parseCsvLine('"a\tb"\tc', '\t'), ['a\tb', 'c']);
    });
  });

  describe('edge cases', function () {
    it('treats junk after a closing quote as ignorable up to the separator', function () {
      // Defensive: real CSV writers should never produce this, but Excel
      // and various exporters are inconsistent. Don't crash.
      assert.deepStrictEqual(parseCsvLine('"hello"junk,b', ','), ['hello', 'b']);
    });

    it('handles a quoted field at end of line with no trailing separator', function () {
      assert.deepStrictEqual(parseCsvLine('a,"b"', ','), ['a', 'b']);
    });
  });
});

describe('detectColumnIsNumeric', function () {
  function rows(grid) { return grid.map(function (r) { return r; }); }

  it('returns true when every non-empty value in the column is a number', function () {
    var grid = rows([['1'], ['2'], ['3.14'], ['-5']]);
    assert.strictEqual(detectColumnIsNumeric(grid, 0), true);
  });

  it('returns false when any value is non-numeric', function () {
    var grid = rows([['1'], ['2'], ['abc'], ['3']]);
    assert.strictEqual(detectColumnIsNumeric(grid, 0), false);
  });

  it('treats empty cells as ignored', function () {
    var grid = rows([['1'], [''], ['2'], [null]]);
    assert.strictEqual(detectColumnIsNumeric(grid, 0), true);
  });

  it('returns false when column is entirely empty', function () {
    // No samples → not numeric (preserves stable string sort default).
    var grid = rows([[''], [''], [null]]);
    assert.strictEqual(detectColumnIsNumeric(grid, 0), false);
  });

  it('only inspects up to 20 rows', function () {
    // First 20 numeric, 21st non-numeric — should still be numeric.
    var grid = [];
    for (var i = 0; i < 20; i++) grid.push([String(i)]);
    grid.push(['oops']);
    assert.strictEqual(detectColumnIsNumeric(grid, 0), true);
  });

  it('rejects Infinity / NaN-shaped tokens', function () {
    assert.strictEqual(detectColumnIsNumeric(rows([['Infinity']]), 0), false);
    assert.strictEqual(detectColumnIsNumeric(rows([['NaN']]), 0), false);
  });

  it('handles the multi-column case', function () {
    var grid = rows([
      ['1', 'apple',  '2.5'],
      ['2', 'banana', '3.5'],
      ['3', 'cherry', '4.5'],
    ]);
    assert.strictEqual(detectColumnIsNumeric(grid, 0), true);
    assert.strictEqual(detectColumnIsNumeric(grid, 1), false);
    assert.strictEqual(detectColumnIsNumeric(grid, 2), true);
  });
});
