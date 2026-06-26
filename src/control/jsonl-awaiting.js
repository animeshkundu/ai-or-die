'use strict';

// Structured detector for Claude Code user-facing tool_use blocks left pending
// in a JSONL transcript. This reads only a bounded tail, skips malformed or
// partial lines, and never throws to callers: unreadable/transient files simply
// mean "no reliable awaiting signal".

const fs = require('fs');

const DEFAULT_MAX_BYTES = 256 * 1024;

async function detectAwaiting(file, opts = {}) {
  try {
    const lines = await readTailJsonLines(file, opts.maxBytes || DEFAULT_MAX_BYTES);
    if (!lines.length) return null;

    let latest = null;
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const obj = lines[lineIndex];
      if (!obj || obj.type !== 'assistant' || obj.isSidechain) continue;
      const content = obj.message && obj.message.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || block.type !== 'tool_use') continue;
        const mapped = mapUserFacingTool(block.name);
        if (!mapped) continue;
        latest = {
          lineIndex,
          id: block.id,
          tool: mapped,
          input: block.input || {},
        };
      }
    }

    if (!latest || !latest.id) return null;
    if (hasMatchingToolResult(lines.slice(latest.lineIndex + 1), latest.id)) return null;
    return awaitingFromTool(latest.tool, latest.input);
  } catch {
    return null;
  }
}

async function readTailJsonLines(file, maxBytes) {
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return [];
  }
  if (!st || !st.size) return [];
  const start = Math.max(0, st.size - Math.max(1, maxBytes || DEFAULT_MAX_BYTES));
  const buf = await readRange(file, start, st.size);
  const lastNl = buf.lastIndexOf(0x0a); // '\n'
  if (lastNl === -1) return [];
  const complete = buf.slice(0, lastNl + 1).toString('utf8');
  const out = [];
  for (const line of complete.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Starting in the middle of a large file can leave a partial first line;
      // the writer may also be appending the final line. Ignore both.
    }
  }
  return out;
}

function readRange(file, start, end) {
  return new Promise((resolve, reject) => {
    if (end <= start) return resolve(Buffer.alloc(0));
    const chunks = [];
    const stream = fs.createReadStream(file, { start, end: end - 1 });
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function mapUserFacingTool(name) {
  if (name === 'ExitPlanMode') return 'ExitPlanMode';
  if (name === 'AskUserQuestion') return 'AskUserQuestion';
  const s = String(name || '');
  if (/permission|approval|approve/i.test(s)) return 'permission';
  return null;
}

function hasMatchingToolResult(lines, toolUseId) {
  for (const obj of lines) {
    if (!obj || obj.type !== 'user' || obj.isSidechain) continue;
    const content = obj.message && obj.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && block.type === 'tool_result' && block.tool_use_id === toolUseId) return true;
    }
  }
  return false;
}

function awaitingFromTool(tool, input) {
  if (tool === 'ExitPlanMode') {
    const out = { pendingUserFacingTool: 'ExitPlanMode' };
    const prompt = shortString(input && input.plan, 300);
    if (prompt) out.awaitingPrompt = prompt;
    return out;
  }

  if (tool === 'AskUserQuestion') {
    const out = { pendingUserFacingTool: 'AskUserQuestion' };
    const prompt = questionPrompt(input);
    const options = questionOptions(input);
    if (prompt) out.awaitingPrompt = prompt;
    if (options.length) out.awaitingOptions = options;
    return out;
  }

  return { pendingUserFacingTool: 'permission' };
}

function questionPrompt(input) {
  if (!input || typeof input !== 'object') return '';
  const direct = firstString(input.question, input.prompt, input.text, input.title);
  if (direct) return direct;
  const questions = Array.isArray(input.questions) ? input.questions : [];
  for (const q of questions) {
    if (!q || typeof q !== 'object') continue;
    const s = firstString(q.question, q.prompt, q.text, q.title, q.label);
    if (s) return s;
  }
  return '';
}

function questionOptions(input) {
  const questions = [];
  if (input && Array.isArray(input.questions)) questions.push(...input.questions);
  if (input && Array.isArray(input.options)) questions.push({ options: input.options });
  const out = [];
  for (const q of questions) {
    const opts = q && Array.isArray(q.options) ? q.options : [];
    for (const opt of opts) {
      const mapped = normalizeOption(opt);
      if (mapped) out.push(mapped);
    }
  }
  return out;
}

function normalizeOption(opt) {
  if (typeof opt === 'string') return { label: opt, value: opt };
  if (!opt || typeof opt !== 'object') return null;
  const label = firstString(opt.label, opt.text, opt.title, opt.name, opt.value);
  if (!label) return null;
  const value = opt.value == null ? label : String(opt.value);
  return { label, value };
}

function firstString(...values) {
  for (const v of values) {
    const s = shortString(v, 300);
    if (s) return s;
  }
  return '';
}

function shortString(value, maxLen) {
  if (value == null) return '';
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

module.exports = { detectAwaiting };
