'use strict';

const assert = require('assert');
const path = require('path');

let JSDOM = null;
try {
  JSDOM = require('jsdom').JSDOM;
} catch (_) {
  /* skip below */
}

const CARD_SRC = path.join(__dirname, '..', 'src', 'public', 'sticky-note-card.js');

describe('sticky-note card (DOM)', function () {
  if (!JSDOM) {
    it('skipped — jsdom not installed', function () {
      this.skip();
    });
    return;
  }

  let StickyNoteCard;
  let app;

  beforeEach(function () {
    const dom = new JSDOM('<!DOCTYPE html><body><div class="terminal-wrapper"></div></body>', {
      url: 'http://localhost',
    });
    global.window = dom.window;
    global.document = dom.window.document;
    global.localStorage = dom.window.localStorage;
    delete require.cache[require.resolve(CARD_SRC)];
    StickyNoteCard = require(CARD_SRC);
    app = { sessionTabManager: { activeSessions: new Map() }, stickyNotesEnabled: true, currentClaudeSessionId: 's1' };
  });

  afterEach(function () {
    delete global.window;
    delete global.document;
    delete global.localStorage;
  });

  it('mounts inside .terminal-wrapper, hidden initially', function () {
    const card = new StickyNoteCard(app);
    assert.ok(document.querySelector('.terminal-wrapper .sticky-note-card'), 'card mounted');
    assert.strictEqual(card.el.hidden, true);
  });

  it('renders model text via textContent — markup is inert (no XSS)', function () {
    const card = new StickyNoteCard(app);
    card.render({
      title: 'x',
      goal: '<img src=x onerror=alert(1)>',
      progress: ['<script>evil()</script>', '<b>bold</b>'],
      waitingOn: [],
      updatedAt: new Date().toISOString(),
    });
    // No element nodes were created from the model output.
    assert.strictEqual(card.el.querySelector('img'), null);
    assert.strictEqual(card.el.querySelector('script'), null);
    assert.strictEqual(card.el.querySelector('b'), null);
    // The literal string is present as text.
    assert.strictEqual(card._refs.goalText.textContent, '<img src=x onerror=alert(1)>');
    const items = Array.from(card._refs.progList.querySelectorAll('li')).map((li) => li.textContent);
    assert.deepStrictEqual(items, ['<script>evil()</script>', '<b>bold</b>']);
    card.hide();
  });

  it('stays hidden when enabled but no note yet (no "gathering" placeholder)', function () {
    const card = new StickyNoteCard(app);
    card.render(null);
    assert.strictEqual(card.el.hidden, true, 'card hidden until a real note arrives');
  });

  it('hides empty sections and shows populated ones', function () {
    const card = new StickyNoteCard(app);
    card.render({ title: 'T', goal: 'fix it', progress: ['did a'], waitingOn: [], updatedAt: new Date().toISOString() });
    assert.strictEqual(card._refs.goalSec.hidden, false);
    assert.strictEqual(card._refs.progSec.hidden, false);
    assert.strictEqual(card._refs.waitSec.hidden, true, 'empty waiting section hidden');
    assert.ok(card._refs.fresh.textContent.startsWith('updated '));
    card.hide();
  });

  it('stays hidden when the feature is disabled', function () {
    app.stickyNotesEnabled = false;
    const card = new StickyNoteCard(app);
    card.render({ title: 'T', goal: 'g', progress: [], waitingOn: [], updatedAt: new Date().toISOString() });
    assert.strictEqual(card.el.hidden, true);
  });

  it('notifyActiveSessionChanged renders from the active session store', function () {
    const card = new StickyNoteCard(app);
    app.sessionTabManager.activeSessions.set('s1', {
      stickyNote: { title: 'T', goal: 'ship it', progress: [], waitingOn: [], updatedAt: new Date().toISOString() },
    });
    card.notifyActiveSessionChanged('s1');
    assert.strictEqual(card.el.hidden, false);
    assert.strictEqual(card._refs.goalText.textContent, 'ship it');
    card.hide();
  });

  it('formats relative freshness', function () {
    const card = new StickyNoteCard(app);
    assert.strictEqual(card._formatAge(5000), 'updated 5s ago');
    assert.strictEqual(card._formatAge(120000), 'updated 2m ago');
    assert.strictEqual(card._formatAge(7200000), 'updated 2h ago');
  });

  it('collapse toggle persists and hides the body', function () {
    const card = new StickyNoteCard(app);
    assert.strictEqual(card._collapsed, false);
    card.toggleCollapse();
    assert.strictEqual(card._collapsed, true);
    assert.ok(card.el.classList.contains('collapsed'));
    assert.strictEqual(localStorage.getItem('cc-sticky-note-collapsed'), '1');
  });
});
