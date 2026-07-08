'use strict';

// Durable semantic reader for Claude Code JSONL transcripts. Unlike the sticky
// note tailer, this never skips ahead after a large byte gap and never flattens
// tool/thinking blocks into prose. It reads from a byte cursor, emits stable
// semantic items, and leaves the cursor at the last complete JSONL line.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COMPACT_MARK = ':compact:';
const TRUNCATED_MARK = ':truncated:';
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_EPOCH_LENGTH = 64;
const VALID_EPOCH_RE = /^[0-9a-f]{16}(:compact:\d+|:truncated:\d+)?$/;
const MAX_ID_LENGTH = 200;
const MAX_SAFE_ID_PART_LENGTH = 80;
const RESERVED_KEY_IDS = new Set(['__proto__', 'prototype', 'constructor']);
const BLOCK_INDEX = Symbol('blockIndex');

function basenameAny(file) {
  return String(file || '').split(/[\\/]/).pop() || '';
}

function isSessionFileName(name) {
  return name.endsWith('.jsonl') && !name.startsWith('agent-');
}

function fileEpoch(file, st) {
  const identity = [path.resolve(String(file || '')), st && st.dev, st && st.ino, st && st.birthtimeMs].join('|');
  return crypto.createHash('sha1').update(identity).digest('hex').slice(0, 16);
}

function epochBase(epoch) {
  const s = String(epoch || '');
  for (const mark of [COMPACT_MARK, TRUNCATED_MARK]) {
    const idx = s.indexOf(mark);
    if (idx !== -1) return s.slice(0, idx);
  }
  return s;
}

function compactEpoch(baseEpoch, lineOffset) {
  return `${baseEpoch}${COMPACT_MARK}${lineOffset}`;
}

function truncatedEpoch(baseEpoch, size) {
  return `${baseEpoch}${TRUNCATED_MARK}${size}`;
}

function validEpoch(epoch) {
  return typeof epoch === 'string' && epoch.length <= MAX_EPOCH_LENGTH && VALID_EPOCH_RE.test(epoch);
}

function normalizeOffset(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) return 0;
  return n;
}

function normalizeLimit(value) {
  if (value == null) return Infinity;
  const n = Number(value);
  if (!Number.isFinite(n)) return Infinity;
  return Math.max(1, Math.trunc(n));
}

function normalizeByteLimit(value, def) {
  if (value == null) return def;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.max(1, Math.trunc(n));
}

async function readBoundaryByte(file, offset) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1);
    const out = await fh.read(buf, 0, 1, offset);
    return out.bytesRead === 1 ? buf[0] : null;
  } finally {
    await fh.close();
  }
}

async function readRange(file, start, end, opts, onRecord) {
  const maxBytes = normalizeByteLimit(opts.maxBytes, DEFAULT_MAX_BYTES);
  const maxLineBytes = Math.min(normalizeByteLimit(opts.maxLineBytes, DEFAULT_MAX_LINE_BYTES), maxBytes);
  const windowEnd = Math.min(end, start + maxBytes);
  const chunkBytes = Math.max(1, Math.min(READ_CHUNK_BYTES, maxBytes));
  let readOffset = start;
  let lineStart = start;
  let lineBytes = 0;
  let lineChunks = [];
  let oversized = false;
  let stopped = false;
  let partialTail = false;

  const fh = await fs.promises.open(file, 'r');
  try {
    while (readOffset < windowEnd && !stopped) {
      const toRead = Math.min(chunkBytes, windowEnd - readOffset);
      const buf = Buffer.allocUnsafe(toRead);
      const out = await fh.read(buf, 0, toRead, readOffset);
      if (!out.bytesRead) break;

      const chunkBase = readOffset;
      const chunk = out.bytesRead === buf.length ? buf : buf.subarray(0, out.bytesRead);
      readOffset += out.bytesRead;
      let segmentStart = 0;

      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 0x0a) continue;

        if (!oversized) appendLineBytes(chunk.subarray(segmentStart, i));
        const lineEnd = chunkBase + i + 1;
        const obj = oversized ? null : parseLine(lineChunks, lineBytes);
        const keepGoing = onRecord({ lineStart, lineEnd, obj, oversized });
        lineStart = lineEnd;
        lineBytes = 0;
        lineChunks = [];
        oversized = false;
        segmentStart = i + 1;
        if (keepGoing === false) {
          stopped = true;
          break;
        }
      }

      if (!stopped && segmentStart < chunk.length) {
        appendLineBytes(chunk.subarray(segmentStart));
      }
    }

    if (!stopped && !oversized && windowEnd < end && readOffset >= windowEnd && lineBytes >= maxLineBytes) {
      oversized = true;
      lineChunks = [];
    }

    if (!stopped && oversized) {
      const lineEnd = await drainOversizedLine(fh, readOffset, end);
      if (lineEnd != null) {
        readOffset = lineEnd;
        onRecord({ lineStart, lineEnd, obj: null, oversized: true });
        lineStart = lineEnd;
        lineBytes = 0;
        lineChunks = [];
        oversized = false;
      } else {
        partialTail = true;
      }
    }
  } finally {
    await fh.close();
  }

  return {
    readOffset,
    stopped,
    partialTail,
    windowTruncated: !stopped && !partialTail && windowEnd < end && readOffset >= windowEnd,
  };

  function appendLineBytes(bytes) {
    if (!bytes.length || oversized) return;
    lineBytes += bytes.length;
    if (lineBytes > maxLineBytes) {
      oversized = true;
      lineChunks = [];
      return;
    }
    lineChunks.push(Buffer.from(bytes));
  }
}

async function drainOversizedLine(fh, offset, end) {
  const buf = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  let readOffset = offset;
  while (readOffset < end) {
    const toRead = Math.min(buf.length, end - readOffset);
    const out = await fh.read(buf, 0, toRead, readOffset);
    if (!out.bytesRead) break;
    const nl = buf.subarray(0, out.bytesRead).indexOf(0x0a);
    if (nl !== -1) return readOffset + nl + 1;
    readOffset += out.bytesRead;
  }
  return null;
}

function parseLine(chunks, length) {
  if (!length) return null;
  const line = Buffer.concat(chunks, length).toString('utf8');
  if (!line.trim()) return null;
  try { return JSON.parse(line); } catch (_) { return null; }
}

/**
 * Read semantic items after a durable cursor. Cursor shape is { epoch, offset },
 * where offset is a byte offset into the transcript and epoch is the current file
 * identity plus any same-file compaction generation. Only complete newline-ended
 * JSONL records are parsed; a trailing partial line is left for the next call.
 */
async function readItems(file, cursor, opts = {}) {
  const limit = normalizeLimit(opts.limit);
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return emptyResult(cursor);
  }

  const baseEpoch = fileEpoch(file, st);
  const rawCursorEpoch = cursor && typeof cursor.epoch === 'string' ? cursor.epoch : null;
  const cursorEpoch = rawCursorEpoch && validEpoch(rawCursorEpoch) ? rawCursorEpoch : null;
  const invalidEpoch = !!rawCursorEpoch && !cursorEpoch;
  const epochChanged = invalidEpoch || !!(cursorEpoch && epochBase(cursorEpoch) !== baseEpoch);
  let epoch = epochChanged ? baseEpoch : (cursorEpoch || baseEpoch);
  let reset = epochChanged;
  let start = epochChanged ? 0 : normalizeOffset(cursor && cursor.offset);

  if (!isSessionFileName(basenameAny(file))) {
    return { items: [], cursor: { epoch, offset: start }, epoch, reset, more: false };
  }

  if (start > st.size) {
    reset = true;
    start = 0;
    epoch = truncatedEpoch(baseEpoch, st.size);
  }

  if (start > 0) {
    let boundary = null;
    try { boundary = await readBoundaryByte(file, start - 1); } catch (_) { boundary = null; }
    if (boundary !== 0x0a) {
      reset = true;
      start = 0;
      epoch = truncatedEpoch(baseEpoch, st.size);
    }
  }

  if (st.size <= start) {
    return { items: [], cursor: { epoch, offset: start }, epoch, reset, more: false };
  }

  const items = [];
  let nextOffset = start;
  let more = false;

  const range = await readRange(file, start, st.size, opts, (rec) => {
    if (isCompactBoundary(rec.obj)) {
      reset = true;
      epoch = compactEpoch(baseEpoch, rec.lineStart);
      items.length = 0;
      nextOffset = rec.lineEnd;
      return true;
    }

    if (rec.oversized || !rec.obj) {
      nextOffset = rec.lineEnd;
      return true;
    }

    const lineItems = itemsForLine(rec.obj, { epoch, lineStart: rec.lineStart });
    if (!lineItems.length) {
      nextOffset = rec.lineEnd;
      return true;
    }

    if (items.length > 0 && items.length + lineItems.length > limit) {
      more = true;
      return false;
    }

    items.push(...lineItems);
    nextOffset = rec.lineEnd;

    if (items.length >= limit && rec.lineEnd < st.size) {
      more = true;
      return false;
    }

    return true;
  });

  if (range.windowTruncated && nextOffset < st.size) more = true;

  return { items, cursor: { epoch, offset: nextOffset }, epoch, reset, more };
}

function emptyResult(cursor) {
  const rawEpoch = cursor && typeof cursor.epoch === 'string' ? cursor.epoch : null;
  const epoch = rawEpoch && validEpoch(rawEpoch) ? rawEpoch : null;
  const offset = epoch ? normalizeOffset(cursor && cursor.offset) : 0;
  return { items: [], cursor: epoch ? { epoch, offset } : null, epoch, reset: false, more: false };
}

function isCompactBoundary(obj) {
  return !!(obj && obj.type === 'system' && obj.subtype === 'compact_boundary');
}

function itemsForLine(obj, ctx) {
  if (!obj || obj.isSidechain) return [];
  if (obj.type === 'user') return userItems(obj, ctx);
  if (obj.type === 'assistant') return assistantItems(obj, ctx);
  return [];
}

function userItems(obj, ctx) {
  const content = obj.message && obj.message.content;
  const out = [];
  if (typeof content === 'string') {
    if (content) out.push(baseItem(obj, 'user-text', { text: content }));
    return assignIds(out, obj, ctx);
  }
  if (!Array.isArray(content)) return [];

  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      const item = baseItem(obj, 'user-text', { text: block.text });
      setBlockIndex(item, i);
      out.push(item);
    } else if (block.type === 'tool_result') {
      const item = baseItem(obj, 'tool-result', {
        toolUseId: block.tool_use_id || null,
        content: Object.prototype.hasOwnProperty.call(block, 'content') ? block.content : null,
        isError: !!block.is_error,
      });
      setBlockIndex(item, i);
      if (Object.prototype.hasOwnProperty.call(obj, 'toolUseResult')) item.toolUseResult = obj.toolUseResult;
      out.push(item);
    }
  }
  return assignIds(out, obj, ctx);
}

function assistantItems(obj, ctx) {
  const content = obj.message && obj.message.content;
  if (!Array.isArray(content)) return [];

  const out = [];
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string' && block.text) {
      const item = baseItem(obj, 'assistant-text', { text: block.text });
      setBlockIndex(item, i);
      out.push(item);
    } else if (block.type === 'tool_use') {
      const item = baseItem(obj, 'tool-call', {
        toolUseId: block.id || null,
        name: block.name || null,
        input: Object.prototype.hasOwnProperty.call(block, 'input') ? block.input : null,
      });
      setBlockIndex(item, i);
      out.push(item);
    } else if (block.type === 'thinking') {
      const item = baseItem(obj, 'thinking', {
        thinking: typeof block.thinking === 'string' ? block.thinking : '',
        signature: block.signature || null,
      });
      setBlockIndex(item, i);
      out.push(item);
    }
  }
  return assignIds(out, obj, ctx);
}

function baseItem(obj, kind, fields) {
  const item = {
    id: null,
    kind,
    uuid: obj.uuid || null,
    timestamp: obj.timestamp || null,
    ...fields,
  };
  if (obj.parentUuid) item.parentUuid = obj.parentUuid;
  if (obj.sessionId) item.sessionId = obj.sessionId;
  if (obj.cwd) item.cwd = obj.cwd;
  return item;
}

function assignIds(items, obj, ctx) {
  if (!items.length) return items;
  const lineId = obj.uuid ? baseLineId(obj.uuid) : fallbackLineId(ctx.epoch, ctx.lineStart);
  if (items.length === 1) {
    items[0].id = capId(lineId);
    return items;
  }
  for (let i = 0; i < items.length; i++) {
    items[i].id = joinId(lineId, idPart(items[i], i));
  }
  return items;
}

function baseLineId(value) {
  let id = capId(safeId(value));
  if (RESERVED_KEY_IDS.has(id)) id = capId(`id-${id}`);
  return id;
}

function fallbackLineId(epoch, lineStart) {
  const safeEpoch = validEpoch(epoch) ? epoch : '0000000000000000';
  return capId(`${safeEpoch}:offset:${normalizeOffset(lineStart)}`);
}

function joinId(base, suffix) {
  const safeBase = capId(base);
  const fullSuffix = `:${suffix}`;
  if (safeBase.length + fullSuffix.length <= MAX_ID_LENGTH) return safeBase + fullSuffix;
  if (fullSuffix.length >= MAX_ID_LENGTH) return capId(safeBase + fullSuffix);
  return `${safeBase.slice(0, MAX_ID_LENGTH - fullSuffix.length)}${fullSuffix}`;
}

function capId(value) {
  const s = String(value || '');
  return s.length > MAX_ID_LENGTH ? s.slice(0, MAX_ID_LENGTH) : s;
}

function setBlockIndex(item, index) {
  Object.defineProperty(item, BLOCK_INDEX, { value: index, enumerable: false });
}

function idPart(item, index) {
  const blockIndex = Number.isSafeInteger(item[BLOCK_INDEX]) ? item[BLOCK_INDEX] : index;
  if (item.kind === 'tool-call') return `tool-call:${safeId(item.toolUseId)}:${blockIndex}`;
  if (item.kind === 'tool-result') return `tool-result:${safeId(item.toolUseId)}:${blockIndex}`;
  return `${item.kind}:${blockIndex}`;
}

function safeId(value) {
  const s = String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '-');
  return (s || 'unknown').slice(0, MAX_SAFE_ID_PART_LENGTH);
}

module.exports = {
  readItems,
  fileEpoch,
  epochBase,
  isSessionFileName,
};
