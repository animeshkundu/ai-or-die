'use strict';

const assert = require('assert');
const { withoutDiagnosticSecrets } = require('../src/utils/child-env');

describe('child process environment', function () {
  it('removes every diagnostic secret while preserving ordinary and extra values', function () {
    const env = withoutDiagnosticSecrets({
      PATH: '/bin',
      AOD_DIAG_ENABLED: '1',
      AOD_DIAG_TOKEN: 'secret',
      AOD_DIAG_SNAPSHOT_DIR: '/private',
    }, {
      TERM: 'xterm-256color',
      AOD_DIAG_TOKEN: 'must-not-be-reintroduced',
    });
    assert.deepStrictEqual(env, {
      PATH: '/bin',
      TERM: 'xterm-256color',
    });
  });
});
