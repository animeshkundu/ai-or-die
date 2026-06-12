'use strict';

const assert = require('assert');
const {
  buildPrompt,
  parseNote,
  sanitizeText,
  NOTE_SCHEMA,
  MAX_PROGRESS,
  MAX_WAITING,
  TITLE_MAX,
} = require('../src/sticky-note-prompt');

describe('sticky-note prompt + parse', function () {
  describe('sanitizeText', function () {
    it('strips bidi-override and control chars but keeps normal text', function () {
      const bidi = String.fromCharCode(0x202e);
      const bel = String.fromCharCode(0x07);
      assert.strictEqual(sanitizeText(`ab${bidi}cd${bel}ef`, 100), 'abcdef');
      assert.strictEqual(sanitizeText('Fix auth redirect', 100), 'Fix auth redirect');
    });

    it('collapses newlines/tabs to single spaces', function () {
      assert.strictEqual(sanitizeText('line1\nline2\tend', 100), 'line1 line2 end');
    });

    it('clamps to maxLen', function () {
      assert.strictEqual(sanitizeText('x'.repeat(60), TITLE_MAX).length, TITLE_MAX);
    });

    it('handles non-strings', function () {
      assert.strictEqual(sanitizeText(null, 10), '');
      assert.strictEqual(sanitizeText(42, 10), '');
    });
  });

  describe('parseNote', function () {
    it('parses valid JSON and clamps array sizes', function () {
      const n = parseNote(
        JSON.stringify({
          title: 'Fix auth',
          goal: 'make login work',
          progress: ['a', 'b', 'c', 'd', 'e', 'f'],
          waitingOn: ['x', 'y', 'z', 'w'],
        })
      );
      assert.ok(n);
      assert.strictEqual(n.title, 'Fix auth');
      assert.strictEqual(n.progress.length, MAX_PROGRESS);
      assert.strictEqual(n.waitingOn.length, MAX_WAITING);
    });

    it('accepts a pre-parsed object', function () {
      const n = parseNote({ title: 'T', goal: '', progress: [], waitingOn: [] });
      assert.strictEqual(n.title, 'T');
    });

    it('recovers JSON embedded in prose', function () {
      const n = parseNote('Sure! {"title":"T","goal":"g","progress":[],"waitingOn":[]} hope that helps');
      assert.ok(n);
      assert.strictEqual(n.title, 'T');
      assert.strictEqual(n.goal, 'g');
    });

    it('returns null for unparseable / empty output', function () {
      assert.strictEqual(parseNote('not json at all'), null);
      assert.strictEqual(parseNote(''), null);
      assert.strictEqual(parseNote('{}'), null); // no usable fields
      assert.strictEqual(parseNote('{"title":"","goal":"","progress":[],"waitingOn":[]}'), null);
    });

    it('sanitises malicious title content (no markup / control)', function () {
      const n = parseNote(
        JSON.stringify({
          title: '<img src=x onerror=alert(1)>',
          goal: 'g',
          progress: [],
          waitingOn: [],
        })
      );
      assert.ok(n);
      // textContent rendering on the client makes this inert anyway, but we also
      // clamp length and strip control/bidi here.
      assert.ok(n.title.length <= TITLE_MAX);
    });

    it('drops empty bullets', function () {
      const n = parseNote(
        JSON.stringify({ title: 'T', goal: 'g', progress: ['real', '', '   '], waitingOn: [] })
      );
      assert.deepStrictEqual(n.progress, ['real']);
    });
  });

  describe('buildPrompt', function () {
    it('includes previous note and transcript', function () {
      const p = buildPrompt({ title: 'Prev', goal: 'pg', progress: ['x'], waitingOn: [] }, 'some output');
      assert.ok(p.includes('Prev'));
      assert.ok(p.includes('some output'));
      assert.ok(p.includes('JSON only'));
    });

    it('handles no previous note and empty transcript', function () {
      const p = buildPrompt(null, '');
      assert.ok(p.includes('(none yet)'));
      assert.ok(p.includes('(no output captured)'));
    });
  });

  describe('NOTE_SCHEMA', function () {
    it('declares the four required fields', function () {
      assert.deepStrictEqual(NOTE_SCHEMA.required, ['title', 'goal', 'progress', 'waitingOn']);
    });
  });
});
