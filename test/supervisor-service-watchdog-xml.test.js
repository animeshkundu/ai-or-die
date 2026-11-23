'use strict';

// The watchdog task's XML is submitted to the SAME Task Scheduler as the
// service task, and a rejected definition there fails silently inside
// install() (the caller only warns). So the one thing that must not be wrong is
// schema order: Task Scheduler validates <Triggers> children in document order
// against its XSD, and a BootTrigger placed after a TimeTrigger is rejected
// outright. These assertions are structural (position based), not substring
// matching, so a reordering is caught here rather than on a customer's machine.
//
// The full acceptance test (real `schtasks /create`) lives in
// test/integration/schtasks-xml.test.js and is opt-in.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ServiceWatchdog } = require('../src/supervisor/service-watchdog');

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aod-wdxml-'));
}

function positions(xml, tags) {
  return tags.map((t) => ({ t, at: xml.indexOf(t) }));
}

describe('watchdog task XML shape', function () {
  let dir;
  let wd;

  beforeEach(function () {
    dir = sandbox();
    wd = new ServiceWatchdog({ baseDir: dir, logger: silent, execFileSync: () => '' });
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('boot mode puts BootTrigger before TimeTrigger', function () {
    const xml = wd.buildWatchdogXml('C:\\node\\node.exe', 'C:\\aod\\bin\\ai-or-die-supervisor.js', {
      mode: 'boot', userId: 'S-1-5-21-1',
    });
    const trig = xml.slice(xml.indexOf('<Triggers>'), xml.indexOf('</Triggers>'));
    const [boot, time] = positions(trig, ['<BootTrigger>', '<TimeTrigger>']);
    assert.ok(boot.at >= 0, 'boot trigger present');
    assert.ok(time.at >= 0, 'time trigger present');
    assert.ok(boot.at < time.at, 'BootTrigger must precede TimeTrigger (Task Scheduler XSD order)');
    assert.ok(/<LogonType>S4U<\/LogonType>/.test(xml), 'boot watchdog runs without an interactive logon');
    assert.ok(/<UserId>S-1-5-21-1<\/UserId>/.test(xml), 'the S4U principal names the account');
  });

  it('login mode carries no BootTrigger and keeps InteractiveToken', function () {
    const xml = wd.buildWatchdogXml('C:\\node\\node.exe', 'C:\\aod\\bin\\ai-or-die-supervisor.js', { mode: 'login' });
    assert.ok(!/<BootTrigger>/.test(xml), 'a login-mode watchdog cannot run before login');
    assert.ok(/<LogonType>InteractiveToken<\/LogonType>/.test(xml));
  });

  it('stays inside the ExecutionTimeLimit so a hung tick cannot wedge the next one', function () {
    const xml = wd.buildWatchdogXml('C:\\node\\node.exe', 'C:\\aod\\bin\\ai-or-die-supervisor.js', { mode: 'boot', userId: 'S-1-5-21-1' });
    assert.ok(/<ExecutionTimeLimit>PT5M<\/ExecutionTimeLimit>/.test(xml));
    assert.ok(/<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/.test(xml));
    // Hidden: a CLI window flashing every five minutes would make the task
    // unusable on a desktop machine.
    assert.ok(/<Hidden>true<\/Hidden>/.test(xml));
  });

  it('quotes the staged entry so a profile path with spaces still parses', function () {
    const xml = wd.buildWatchdogXml('C:\\Program Files\\nodejs\\node.exe',
      'C:\\Users\\First Last\\.ai-or-die\\bin\\ai-or-die-supervisor.js', { mode: 'boot', userId: 'S-1-5-21-1' });
    const cmd = /<Command>(.*?)<\/Command>/.exec(xml)[1];
    const args = /<Arguments>(.*?)<\/Arguments>/.exec(xml)[1];
    assert.ok(cmd.includes('Program Files'), 'command path is preserved verbatim in XML (escaped, not quoted)');
    // XML-escaped double quote: `&quot;C:\Users\First Last\...`. A raw quote
    // would terminate the attribute-style argument list schtasks parses.
    assert.ok(args.startsWith('&quot;C:\\Users\\First Last\\'),
      `the spacey supervisor path must be quoted inside Arguments, got: ${args}`);
    assert.ok(!/["']/.test(args), 'no raw quote survives into the XML body');
  });
});
