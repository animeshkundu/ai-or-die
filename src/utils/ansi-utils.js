'use strict';

/**
 * Combined ANSI escape sequence regex: OSC | CSI | single-char ESC.
 * Single pass — avoids multiple .replace() scans.
 */
const ANSI_RE = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/g;

/**
 * Common secret-value patterns to redact from output snippets.
 */
const SECRET_RE = /\b(password|passwd|secret|token|api_?key|auth|bearer|credential)s?\s*[=:]\s*\S+/gi;

/**
 * Strip all ANSI escape sequences from text.
 * @param {string} text
 * @returns {string}
 */
function stripAnsi(text) {
  if (!text) return '';
  return String(text).replace(ANSI_RE, '');
}

/**
 * Clean control characters (except newline/tab) and normalize line endings.
 * @param {string} text - Pre-stripped (ANSI-free) text.
 * @returns {string}
 */
function cleanControl(text) {
  if (!text) return '';
  return text
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
    .trim();
}

/**
 * Determine whether input contains meaningful (non-control, non-ANSI) characters.
 * @param {string} input
 * @returns {boolean}
 */
function isMeaningfulInput(input) {
  if (typeof input !== 'string' || input.length === 0) return false;
  const clean = stripAnsi(input)
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim();
  return clean.length > 0;
}

/**
 * Extract the last meaningful line from output text (max 180 chars).
 * @param {string} cleanText - Pre-stripped, pre-cleaned text.
 * @returns {string}
 */
function extractActivitySnippet(cleanText) {
  if (!cleanText) return '';
  const lines = cleanText
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return '';
  return lines[lines.length - 1].replace(/\s+/g, ' ').slice(0, 180);
}

/** @type {Array<{regex: RegExp, label: string, kind: string}>} */
const completionPatterns = [
  // Success patterns
  { regex: /\b(?:all\s+tests\s+passed|tests?\s+passed)\b/i, label: 'Tests passed', kind: 'success' },
  { regex: /\b(?:build\s+successful|build\s+completed|compilation\s+finished)\b/i, label: 'Build completed', kind: 'success' },
  { regex: /\b(?:deployment\s+complete|deployment\s+completed|deployment\s+successful)\b/i, label: 'Deployment completed', kind: 'success' },
  { regex: /\b(?:completed\s+successfully|task\s+completed)\b/i, label: 'Task completed', kind: 'success' },
  { regex: /\bDone\s+in\s+\d+(?:\.\d+)?s\b/i, label: 'Task completed', kind: 'success' },
  // Error/failure patterns
  { regex: /\b(?:tests?\s+failed|test\s+failure|FAIL)\b/i, label: 'Tests failed', kind: 'error' },
  { regex: /\b(?:build\s+failed|compilation\s+error|build\s+error)\b/i, label: 'Build failed', kind: 'error' },
];

/**
 * Detect completion or failure metadata from cleaned output text.
 * @param {string} cleanText - Pre-stripped, pre-cleaned text.
 * @returns {{kind: string, label: string} | null}
 */
function detectCompletionMetadata(cleanText) {
  if (!cleanText) return null;

  for (const pattern of completionPatterns) {
    if (pattern.regex.test(cleanText)) {
      return { kind: pattern.kind, label: pattern.label };
    }
  }
  return null;
}

/**
 * Redact common secret patterns from a snippet string.
 * @param {string} text
 * @returns {string}
 */
function redactSecrets(text) {
  if (!text) return text;
  return text.replace(SECRET_RE, '$1=[REDACTED]');
}

module.exports = {
  ANSI_RE,
  stripAnsi,
  cleanControl,
  isMeaningfulInput,
  extractActivitySnippet,
  detectCompletionMetadata,
  redactSecrets,
};
