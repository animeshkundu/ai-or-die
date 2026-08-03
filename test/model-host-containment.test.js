'use strict';

const assert = require('assert');
const { buildOrphanSweepScript } = require('../src/model-host-containment');

describe('model-host Windows orphan sweep', function () {
  it('requires a model-host runtime, entrypoint, host name, and original parent', function () {
    const script = buildOrphanSweepScript(1234);
    assert.match(script, /Name -match/);
    assert.match(script, /stt-host\|sticky-note-host/);
    assert.match(script, /--ai-or-die-model-host/);
    assert.match(script, /--host=\(\?:stt\|sticky-note\)/);
    assert.match(script, /ParentProcessId -eq \$ownerPid/);
    assert.match(script, /\$ownerPid -ne \$self/);
  });

  it('does not classify shell executables as model hosts', function () {
    const script = buildOrphanSweepScript(1234);
    assert.match(script, /\^\(\?:node\|bun\)/);
    assert.ok(!script.includes('powershell|pwsh|cmd'));
  });
});
