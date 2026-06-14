'use strict';

// Redacts likely-secret material from text before it is sent to the local
// summarizer model AND (defensively) from the model's output before it is
// persisted/broadcast. Terminal output routinely contains API keys, tokens,
// private keys, and credentialed URLs; the sticky note is a curated,
// persisted, broadcast artifact, so we strip secrets at both ends.
//
// This is best-effort pattern matching, not a guarantee. It deliberately
// errs toward over-redaction (e.g. long hex/base64 blobs, which may include
// benign hashes) because a missed secret is far worse than a redacted hash
// in a status summary.

const REDACTED = '[redacted]';

// Multi-line first: PEM-style private key blocks.
const PEM_BLOCK =
  /-----BEGIN (?:[A-Z0-9 ]*?)PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]*?)PRIVATE KEY-----/g;

// scheme://user:password@host  -> redact the password (keep user + host for context)
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.\-]*:\/\/[^\s:/@]+):([^\s/@]+)@/gi;

// Authorization: <scheme> <token>   and bare  Bearer <token>
const AUTH_HEADER =
  /\b(Authorization\s*[:=]\s*)(?:Bearer|Basic|Token|Digest)\s+[A-Za-z0-9._\-+/=]+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi;

// JSON Web Tokens (header.payload.signature)
const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;

// Well-known provider key shapes.
const PROVIDER_KEYS = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/g, // AWS temporary access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub ghp_/gho_/ghu_/ghs_/ghr_ tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained PAT
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g, // OpenAI / Anthropic style keys
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g, // GitLab PAT
];

// KEY=VALUE or KEY: VALUE where the key name looks sensitive. Keep the key
// name (useful context) and redact only the value.
const ENV_ASSIGNMENT =
  /\b([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|AUTH)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"']+)\3/gi;

// High-entropy blobs as a catch-all. Hex >= 40 chars (sha1/sha256/keys), and
// base64-ish >= 40 chars that mix upper/lower/digits. The base64 candidate is
// matched with a LINEAR pattern (no nested lookaheads -> no catastrophic
// backtracking / ReDoS) and the mixed-class check is done per-match with plain
// .test(); the earlier lookahead form stalled the main thread on long inputs.
const LONG_HEX = /\b[0-9a-fA-F]{40,}\b/g;
const LONG_BASE64_CANDIDATE = /\b[A-Za-z0-9+/]{40,}={0,2}\b/g;

/**
 * Redact likely secrets from a string.
 * @param {string} text
 * @returns {string}
 */
function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return text;

  let out = text;

  out = out.replace(PEM_BLOCK, REDACTED);
  out = out.replace(URL_CREDENTIALS, (m, prefix) => `${prefix}:${REDACTED}@`);
  out = out.replace(AUTH_HEADER, (m, label) => `${label}${REDACTED}`);
  out = out.replace(BEARER, `Bearer ${REDACTED}`);
  out = out.replace(JWT, REDACTED);

  for (const re of PROVIDER_KEYS) {
    out = out.replace(re, REDACTED);
  }

  out = out.replace(ENV_ASSIGNMENT, (m, key, sep) => `${key}${sep}${REDACTED}`);

  out = out.replace(LONG_HEX, REDACTED);
  out = out.replace(LONG_BASE64_CANDIDATE, (m) =>
    /[A-Z]/.test(m) && /[a-z]/.test(m) && /[0-9]/.test(m) ? REDACTED : m
  );

  return out;
}

module.exports = { redactSecrets, REDACTED };
