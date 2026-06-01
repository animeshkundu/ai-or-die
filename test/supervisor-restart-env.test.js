'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Verifies the supervisor's browser-auto-open suppression contract:
//   - the FIRST spawn carries no AOD_SUPERVISOR_RESTART (so --open may open a browser)
//   - every RESTART spawn sets AOD_SUPERVISOR_RESTART=1 (so it never reopens)

describe('supervisor: restart marks AOD_SUPERVISOR_RESTART', function () {
  this.timeout(15000);

  const supervisorScript = path.join(__dirname, '..', 'bin', 'supervisor.js');
  const mockScript = path.join(__dirname, 'fixtures', 'mock-env-recorder-server.js');
  let recordFile;

  beforeEach(function () {
    recordFile = path.join(os.tmpdir(), `aod-superv-env-${Date.now()}-${process.pid}.log`);
    try { fs.unlinkSync(recordFile); } catch (_) { /* fresh */ }
  });

  afterEach(function () {
    try { fs.unlinkSync(recordFile); } catch (_) { /* ignore */ }
  });

  it('first launch has no restart flag; the restart spawn sets it', function (done) {
    const proc = spawn(process.execPath, [supervisorScript], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        SUPERVISOR_CHILD_SCRIPT: mockScript,
        MOCK_ENV_RECORD_FILE: recordFile,
        RESTART_DELAY_MS: '200',
      },
    });

    proc.on('exit', () => {
      let lines;
      try {
        lines = fs.readFileSync(recordFile, 'utf8').trim().split('\n').filter(Boolean);
      } catch (err) {
        return done(err);
      }
      try {
        assert.strictEqual(lines.length, 2, `expected 2 spawns, got ${lines.length}: ${JSON.stringify(lines)}`);
        assert.match(lines[0], /restart= /, 'first spawn must NOT set AOD_SUPERVISOR_RESTART');
        assert.match(lines[0], /supervised=1/, 'first spawn is supervised');
        assert.match(lines[1], /restart=1/, 'restart spawn must set AOD_SUPERVISOR_RESTART=1');
        done();
      } catch (err) {
        done(err);
      }
    });

    proc.on('error', done);
  });
});
