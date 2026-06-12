'use strict';

const assert = require('assert');
const { redactSecrets, REDACTED } = require('../src/utils/secret-redact');

describe('secret-redact', function () {
  function redactedAway(secret, context) {
    const input = context.replace('__S__', secret);
    const out = redactSecrets(input);
    assert.ok(!out.includes(secret), `expected secret to be removed from: ${out}`);
    assert.ok(out.includes(REDACTED), `expected ${REDACTED} marker in: ${out}`);
  }

  it('redacts AWS access key ids', function () {
    redactedAway('AKIAIOSFODNN7EXAMPLE', 'aws_key = __S__ done');
  });

  it('redacts GitHub tokens', function () {
    redactedAway('ghp_' + 'a'.repeat(36), 'token __S__ here');
    redactedAway('github_pat_' + 'b'.repeat(40), 'pat __S__ here');
  });

  it('redacts OpenAI / Anthropic style keys', function () {
    redactedAway('sk-' + 'A1b2'.repeat(8), 'key=__S__');
    redactedAway('sk-ant-' + 'X9y8'.repeat(8), 'key=__S__');
  });

  it('redacts Google API keys', function () {
    redactedAway('AIza' + 'B'.repeat(35), 'GOOGLE __S__ end');
  });

  it('redacts Slack tokens', function () {
    redactedAway('xoxb-' + '123456789012-abcdEFGHijkl', 'slack __S__ end');
  });

  it('redacts JWTs', function () {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    redactedAway(jwt, 'auth __S__ done');
  });

  it('redacts bare Bearer tokens', function () {
    redactedAway('abcDEF123456ghiJKL789', 'Bearer __S__');
  });

  it('redacts Authorization headers and keeps the label', function () {
    const out = redactSecrets('Authorization: Bearer abc.def.ghi123456');
    assert.ok(out.startsWith('Authorization:'), out);
    assert.ok(!out.includes('abc.def.ghi123456'), out);
    assert.ok(out.includes(REDACTED), out);
  });

  it('redacts a multi-line PEM private key block', function () {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA1234567890abcdefABCDEF',
      'ghijklmnopqrstuvwxyz0987654321ZYXWVU',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactSecrets('before\n' + pem + '\nafter');
    assert.ok(out.includes('before') && out.includes('after'), out);
    assert.ok(!out.includes('MIIEowIBAAKCAQEA'), out);
    assert.ok(out.includes(REDACTED), out);
  });

  it('redacts credentials embedded in URLs, keeps host', function () {
    const out = redactSecrets('postgres://admin:s3cr3tP@ss@db.example.com:5432/app');
    assert.ok(!out.includes('s3cr3tP@ss'.split('@')[0]), out); // password gone
    assert.ok(out.includes('db.example.com'), out); // host kept
    assert.ok(out.includes(REDACTED), out);
  });

  it('redacts sensitive KEY=VALUE / KEY: VALUE but keeps the key name', function () {
    let out = redactSecrets('DB_PASSWORD=hunter2supersecret');
    assert.ok(out.includes('DB_PASSWORD'), out);
    assert.ok(!out.includes('hunter2supersecret'), out);

    out = redactSecrets('API_KEY: "abcd1234efgh5678ijkl"');
    assert.ok(out.includes('API_KEY'), out);
    assert.ok(!out.includes('abcd1234efgh5678ijkl'), out);

    out = redactSecrets('CLIENT_SECRET=zzzTopSecretValue999');
    assert.ok(!out.includes('zzzTopSecretValue999'), out);
  });

  it('redacts long hex and mixed base64 blobs', function () {
    redactedAway('a'.repeat(64), 'sha __S__ end'); // 64 hex
    redactedAway('AbCdEf0123456789AbCdEf0123456789AbCdEf01', 'blob __S__ end'); // mixed b64 >=40
  });

  it('preserves benign text', function () {
    const benign = [
      'Running npm test in /usr/local/bin/project',
      "git commit -m 'fix the login redirect bug'",
      'The quick brown fox jumps over the lazy dog.',
      'color: #fff; background: #1a1a1a;',
      'thequickbrownfoxjumpsoverthelazydogsabcd', // 40 lowercase letters, not hex/b64-mixed
      'Build succeeded in 12.3s with 0 errors',
    ].join('\n');
    const out = redactSecrets(benign);
    assert.strictEqual(out, benign, `benign text should be untouched:\n${out}`);
  });

  it('stays linear on long repetitive input (ReDoS guard)', function () {
    const big = 'A/'.repeat(40000); // 80KB of base64-ish chars
    const t0 = Date.now();
    redactSecrets(big);
    assert.ok(Date.now() - t0 < 500, `redaction must stay linear, took ${Date.now() - t0}ms`);
  });

  it('handles empty / non-string input', function () {
    assert.strictEqual(redactSecrets(''), '');
    assert.strictEqual(redactSecrets(null), null);
    assert.strictEqual(redactSecrets(undefined), undefined);
  });
});
