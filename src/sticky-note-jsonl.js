'use strict';

// Read clean conversation turns from a Claude Code session JSONL transcript.
//
// `github-router claude` runs the normal claude CLI with CLAUDE_CONFIG_DIR=$HOME/.claude,
// so each session writes ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl — a complete,
// structured log (the same source claude uses for --resume). We summarise THIS instead
// of scraping the Ink TUI (which repaints in place and can't be scraped).
//
// Signal we keep: user `string`/`text` prompts, assistant `text` replies, and the NAMES
// of tools the assistant ran. We skip `thinking`, `tool_result`, metadata line types, and
// sidechain (subagent) lines, and strip system-injected blocks (<task-notification>,
// <system-reminder>, slash-command wrappers) so the model sees genuine intent.

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');

// github-router forces the spawned claude CLI to CLAUDE_CONFIG_DIR=$HOME/.claude,
// so transcripts always land under ~/.claude/projects (also the default for plain
// claude). AIORDIE_CLAUDE_PROJECTS_DIR overrides the location (tests / custom setups).
const DEFAULT_PROJECTS_DIR =
  process.env.AIORDIE_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
const PER_TURN_MAX = 1500; // cap one turn's text so a huge reply can't blow the context
const READ_MAX_BYTES = 512 * 1024; // never read more than this in one call

/** Claude's project-dir slug for a cwd: all path separators → '-'. */
function slugForCwd(cwd) {
  return String(cwd || '').replace(/[\\/]/g, '-');
}

/**
 * Find the most-recently-modified .jsonl session file for a cwd's project dir.
 * @returns {Promise<{file:string, mtimeMs:number, size:number}|null>}
 */
async function findActiveSession(cwd, opts = {}) {
  const projectsDir = opts.projectsDir || DEFAULT_PROJECTS_DIR;
  const dir = path.join(projectsDir, slugForCwd(cwd));
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return null; // no project dir → tab isn't running claude here
  }
  let best = null;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    try {
      const st = await fsp.stat(full);
      if (!best || st.mtimeMs > best.mtimeMs) {
        best = { file: full, mtimeMs: st.mtimeMs, size: st.size };
      }
    } catch {
      /* ignore unreadable */
    }
  }
  return best;
}

function clip(s) {
  if (typeof s !== 'string') return '';
  return s.length > PER_TURN_MAX ? s.slice(0, PER_TURN_MAX) : s;
}

/** Pull plain text from a message.content (string or array of typed blocks). */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join(' ');
}

/** Names of tools the assistant invoked in this message. */
function toolNames(content) {
  if (!Array.isArray(content)) return [];
  const names = [];
  for (const b of content) {
    if (b && b.type === 'tool_use' && b.name) names.push(b.name);
  }
  return names;
}

/** Remove system-injected blocks so a user turn reflects genuine intent. */
function stripInjected(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-[a-z-]+>[\s\S]*?<\/command-[a-z-]+>/g, '')
    .replace(/<local-command-[a-z-]+>[\s\S]*?<\/local-command-[a-z-]+>/g, '')
    .trim();
}

function readRange(file, start, end) {
  return new Promise((resolve, reject) => {
    if (end <= start) return resolve(Buffer.alloc(0));
    const chunks = [];
    const stream = fs.createReadStream(file, { start, end: end - 1 });
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Read new conversation turns appended since `byteOffset`. Parses only up to the
 * last complete line (never past an incomplete trailing line) and returns the new
 * byte offset to resume from. A partial first line (when starting mid-file) fails
 * JSON.parse and is skipped harmlessly.
 * @returns {Promise<{turns:Array, offset:number, aiTitle:string|null}>}
 */
async function readNewTurns(file, byteOffset = 0, opts = {}) {
  const maxBytes = opts.maxBytes || READ_MAX_BYTES;
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return { turns: [], offset: byteOffset, aiTitle: null };
  }
  let start = Math.max(0, byteOffset);
  if (st.size <= start) return { turns: [], offset: start, aiTitle: null };
  // Cap how much we read; on a big jump, take only the most recent window.
  if (st.size - start > maxBytes) start = st.size - maxBytes;

  const buf = await readRange(file, start, st.size);
  const lastNl = buf.lastIndexOf(0x0a); // '\n'
  if (lastNl === -1) return { turns: [], offset: byteOffset, aiTitle: null }; // no complete line yet
  const complete = buf.slice(0, lastNl + 1);
  const newOffset = start + complete.length;

  const turns = [];
  let aiTitle = null;
  for (const line of complete.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // partial first line or non-JSON noise
    }
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
      aiTitle = obj.aiTitle; // keep the latest
      continue;
    }
    if (obj.isSidechain) continue;
    if (obj.type !== 'user' && obj.type !== 'assistant') continue;
    const content = obj.message && obj.message.content;
    if (obj.type === 'user') {
      const t = stripInjected(extractText(content));
      if (t) turns.push({ role: 'user', text: clip(t), at: obj.timestamp || null });
    } else {
      const t = extractText(content).trim();
      const tools = toolNames(content);
      if (t || tools.length) {
        turns.push({ role: 'assistant', text: clip(t), toolNames: tools, at: obj.timestamp || null });
      }
    }
  }
  return { turns, offset: newOffset, aiTitle };
}

/** Whether the most recent turn completes an assistant reply (a clean summary boundary). */
function endsOnAssistant(turns) {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'assistant' && turns[i].text) return true;
    if (turns[i].role === 'user') return false;
  }
  return false;
}

/** Format extracted turns as compact prompt text. */
function formatTurns(turns) {
  return (turns || [])
    .map((t) => {
      if (t.role === 'user') return t.text ? `User: ${t.text}` : '';
      let s = t.text ? `Assistant: ${t.text}` : 'Assistant:';
      if (t.toolNames && t.toolNames.length) s += ` [ran: ${t.toolNames.join(', ')}]`;
      return s;
    })
    .filter(Boolean)
    .join('\n');
}

module.exports = {
  slugForCwd,
  findActiveSession,
  readNewTurns,
  formatTurns,
  endsOnAssistant,
  extractText,
  toolNames,
  stripInjected,
  DEFAULT_PROJECTS_DIR,
};
