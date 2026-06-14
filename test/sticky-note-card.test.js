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

describe('sticky-note card (DOM, v2: goal/done/remaining/updates + toolbar minimize)', function () {
  if (!JSDOM) {
    it('skipped — jsdom not installed', function () {
      this.skip();
    });
    return;
  }

  let StickyNoteCard;
  let app;

  beforeEach(function () {
    const dom = new JSDOM(
      '<!DOCTYPE html><body><div class="terminal-wrapper"></div><button id="stickyNoteBtn"></button></body>',
      { url: 'http://localhost' }
    );
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

  const note = (over = {}) => Object.assign({
    title: 'T', goal: 'ship it', done: ['did a'], remaining: ['need b'],
    updates: [{ text: 'older', at: new Date(Date.now() - 60000).toISOString() }, { text: 'newer', at: new Date().toISOString() }],
    updatedAt: new Date().toISOString(),
  }, over);

  it('mounts inside .terminal-wrapper and is MINIMIZED by default (hidden, no chip)', function () {
    const card = new StickyNoteCard(app);
    assert.ok(document.querySelector('.terminal-wrapper #stickyNoteCard'), 'card mounted');
    assert.strictEqual(card.isCollapsed(), true, 'minimized by default');
    assert.strictEqual(card.el.hidden, true);
    assert.strictEqual(card.el.classList.contains('collapsed'), false, 'no floating chip class');
  });

  it('expand() shows the card and renders Goal/Done/Remaining/Updates via textContent (XSS-inert)', function () {
    const card = new StickyNoteCard(app);
    card.render(note({ goal: '<img src=x onerror=alert(1)>', done: ['<script>evil()</script>'] }));
    card.expand();
    assert.strictEqual(card.el.hidden, false, 'visible once expanded with a note');
    assert.strictEqual(card.el.querySelector('img'), null);
    assert.strictEqual(card.el.querySelector('script'), null);
    assert.strictEqual(card._refs.goalText.textContent, '<img src=x onerror=alert(1)>');
    const done = Array.from(card._refs.doneList.querySelectorAll('li')).map((li) => li.textContent);
    assert.deepStrictEqual(done, ['<script>evil()</script>']);
  });

  it('renders the Updates log newest-first with timestamps', function () {
    const card = new StickyNoteCard(app);
    card.expand();
    card.render(note());
    const texts = Array.from(card._refs.updList.querySelectorAll('.sn-update-text')).map((s) => s.textContent);
    assert.deepStrictEqual(texts, ['older', 'newer'], 'renders updates in given (newest-first) order');
    assert.ok(card._refs.updList.querySelector('.sn-update-at'), 'shows a relative timestamp');
  });

  it('stays hidden when collapsed even with a note', function () {
    const card = new StickyNoteCard(app);
    card.render(note());
    assert.strictEqual(card.isCollapsed(), true);
    assert.strictEqual(card.el.hidden, true, 'collapsed hides the card');
  });

  it('expanded but no note shows the "No status yet" placeholder', function () {
    const card = new StickyNoteCard(app);
    card.expand();
    card.render(null);
    assert.strictEqual(card.el.hidden, false);
    assert.strictEqual(card._refs.placeholder.hidden, false);
    assert.strictEqual(card._refs.goalSec.hidden, true);
  });

  it('stays hidden when the feature is disabled', function () {
    app.stickyNotesEnabled = false;
    const card = new StickyNoteCard(app);
    card.expand();
    card.render(note());
    assert.strictEqual(card.el.hidden, true);
  });

  it('toggleCollapse persists and never adds a floating-chip class', function () {
    const card = new StickyNoteCard(app);
    card.render(note());
    assert.strictEqual(card._refs.minimizeBtn.textContent, '–', 'in-card button is minimize');
    card.expand(); // collapsed=false
    assert.strictEqual(card._collapsed, false);
    assert.strictEqual(localStorage.getItem('cc-sticky-note-collapsed'), '0');
    assert.strictEqual(card.el.hidden, false);
    card.collapse(); // back to minimized
    assert.strictEqual(card._collapsed, true);
    assert.strictEqual(localStorage.getItem('cc-sticky-note-collapsed'), '1');
    assert.strictEqual(card.el.hidden, true);
    assert.strictEqual(card.el.classList.contains('collapsed'), false);
  });

  it('always starts collapsed, even if a previous session was expanded (expand = activate)', function () {
    localStorage.setItem('cc-sticky-note-collapsed', '0'); // user previously expanded
    const card = new StickyNoteCard(app);
    assert.strictEqual(card.isCollapsed(), true, 'starts collapsed regardless of stored preference');
  });

  it('onStateChange reports collapsed/hasNote/summarizing for the toolbar button', function () {
    const card = new StickyNoteCard(app);
    const states = [];
    card.onStateChange = (s) => states.push(s);
    card.render(note());
    const last = states[states.length - 1];
    assert.strictEqual(last.hasNote, true);
    assert.strictEqual(last.collapsed, true);
    card.setStatus('summarizing');
    assert.strictEqual(states[states.length - 1].summarizing, true);
    card.render(null);
    assert.strictEqual(states[states.length - 1].hasNote, false);
  });

  it('notifyActiveSessionChanged renders the active tab note (per-tab, no leak)', function () {
    const card = new StickyNoteCard(app);
    card.expand();
    app.sessionTabManager.activeSessions.set('s1', { stickyNote: note({ goal: 'tab one' }) });
    app.sessionTabManager.activeSessions.set('s2', { stickyNote: null });
    card.notifyActiveSessionChanged('s1');
    assert.strictEqual(card._refs.goalText.textContent, 'tab one');
    card.notifyActiveSessionChanged('s2'); // switching to a tab with no note
    assert.strictEqual(card._refs.placeholder.hidden, false, 'no leak from the previous tab');
  });

  it('formats relative freshness', function () {
    const card = new StickyNoteCard(app);
    assert.strictEqual(card._formatAge(5000), 'updated 5s ago');
    assert.strictEqual(card._formatAge(120000), 'updated 2m ago');
    assert.strictEqual(card._shortAge(120000), '2m');
  });
});
