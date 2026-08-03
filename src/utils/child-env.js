'use strict';

function withoutDiagnosticSecrets(source = process.env, extra = {}) {
  const env = { ...source, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith('AOD_DIAG_')) delete env[key];
  }
  return env;
}

module.exports = { withoutDiagnosticSecrets };
