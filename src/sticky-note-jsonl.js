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
const PER_TURN_MAX = 700; // cap one turn's text — short + clean reads best for a 1B model
const READ_MAX_BYTES = 512 * 1024; // never read more than this in one call

/** Strip code blocks + markdown formatting to plain prose (easier for a small model). */
function cleanProse(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(/```[\s\S]*?```/g, ' [code] ')   // fenced code → marker
    .replace(/`[^`]*`/g, (m) => m.slice(1, -1)) // inline code → its text
    .replace(/^#{1,6}\s+/gm, '')               // heading markers
    .replace(/^\s*[-*+]\s+/gm, '')             // bullet markers
    .replace(/^\s*\d+\.\s+/gm, '')             // numbered-list markers
    .replace(/\*\*([^*]+)\*\*/g, '$1')          // bold
    .replace(/\s+/g, ' ')
    .trim();
}

/** Claude's project-dir slug for a cwd: all path separators → '-'. */
function slugForCwd(cwd) {
  return String(cwd || '').replace(/[\\/]/g, '-');
}

/** The claude session id is the JSONL basename (the --resume key). */
function sessionIdForFile(file) {
  return path.basename(String(file || ''), '.jsonl');
}

/**
 * Is this a real claude SESSION transcript (not a subagent sidechain log)?
 * Main sessions are `<sessionId>.jsonl`; subagent runs write `agent-*.jsonl`
 * into the same project dir — those must never bind to a tab.
 */
function isSessionFileName(name) {
  return name.endsWith('.jsonl') && !name.startsWith('agent-');
}

/**
 * All claude session transcripts for a cwd's project dir, newest-mtime first.
 * Skips `agent-*.jsonl` subagent logs. Used by the binder for ownership-aware
 * selection (so two tabs in one project don't fight over the same file).
 * @returns {Promise<Array<{file:string, mtimeMs:number, size:number, sessionId:string}>>}
 */
async function findActiveSessions(cwd, opts = {}) {
  const projectsDir = opts.projectsDir || DEFAULT_PROJECTS_DIR;
  const dir = path.join(projectsDir, slugForCwd(cwd));
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return []; // no project dir → tab isn't running claude here
  }
  const out = [];
  for (const name of entries) {
    if (!isSessionFileName(name)) continue;
    const full = path.join(dir, name);
    try {
      const st = await fsp.stat(full);
      out.push({ file: full, mtimeMs: st.mtimeMs, size: st.size, sessionId: sessionIdForFile(full) });
    } catch {
      /* ignore unreadable */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/**
 * The most-recently-modified claude session transcript for a cwd (newest first,
 * `agent-*.jsonl` excluded).
 * @returns {Promise<{file:string, mtimeMs:number, size:number, sessionId:string}|null>}
 */
async function findActiveSession(cwd, opts = {}) {
  const all = await findActiveSessions(cwd, opts);
  return all.length ? all[0] : null;
}

function clip(s) {
  if (typeof s !== 'string') return '';
  return s.length > PER_TURN_MAX ? s.slice(0, PER_TURN_MAX) : s;
}

/** Pull plain text from a message.content (string or array of typed blocks). */
function extractText(content) {
  if (typeof content === 'string') return cleanProse(content);
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return cleanProse(parts.join(' '));
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

/**
 * CHEAP scan for the latest `ai-title` since `byteOffset` — no turn extraction,
 * no model. Used to keep a tab title fresh even when note summarisation is paused
 * (collapsed). Reads a FORWARD chunk (never skips ahead), so over successive
 * polls it walks the whole file and catches an ai-title written anywhere.
 * @returns {Promise<{aiTitle:string|null, offset:number}>}
 */
async function readNewAiTitle(file, byteOffset = 0, opts = {}) {
  const maxBytes = opts.maxBytes || READ_MAX_BYTES;
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return { aiTitle: null, offset: byteOffset };
  }
  const start = Math.max(0, byteOffset);
  if (st.size <= start) return { aiTitle: null, offset: start };
  const end = Math.min(st.size, start + maxBytes); // forward chunk, never skip
  const buf = await readRange(file, start, end);
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl === -1) return { aiTitle: null, offset: byteOffset }; // no complete line yet
  const complete = buf.slice(0, lastNl + 1);
  const newOffset = start + complete.length;
  let aiTitle = null;
  for (const line of complete.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o.type === 'ai-title' && typeof o.aiTitle === 'string') aiTitle = o.aiTitle;
    } catch {
      /* partial / non-JSON noise */
    }
  }
  return { aiTitle, offset: newOffset };
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
  sessionIdForFile,
  isSessionFileName,
  findActiveSession,
  findActiveSessions,
  readNewTurns,
  readNewAiTitle,
  formatTurns,
  endsOnAssistant,
  extractText,
  toolNames,
  stripInjected,
  DEFAULT_PROJECTS_DIR,
};
