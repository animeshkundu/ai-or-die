'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OutputFrameBatcher = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Tail-only boundary scan (≤16B): hold a trailing partial ESC/CSI/OSC or
  // incomplete UTF-8 sequence for the next frame so a 96KiB budget cut never
  // splits an escape sequence or multibyte char. Returns the holdback length
  // in bytes (0 when the tail is complete). Pure byte scan — CRLF-safe.
  function trailingHoldbackLength(buf) {
    if (!buf || buf.length === 0) return 0;
    const SCAN = Math.min(16, buf.length);
    const tail = buf.length - SCAN;
    // 1) Incomplete UTF-8: count trailing continuation bytes (10xxxxxx).
    let cont = 0;
    for (let i = buf.length - 1; i >= tail; i--) {
      const b = buf[i];
      if (b >= 0x80 && b <= 0xBF) cont++;
      else break;
    }
    if (cont > 0) {
      const leadIdx = buf.length - 1 - cont;
      if (leadIdx < 0) return buf.length > SCAN ? SCAN : 0; // all continuation in scan window: hold scan portion
      const lead = buf[leadIdx];
      let expected = 0;
      if (lead >= 0xC2 && lead <= 0xDF) expected = 2;
      else if (lead >= 0xE0 && lead <= 0xEF) expected = 3;
      else if (lead >= 0xF0 && lead <= 0xF4) expected = 4;
      else return 0; // stray continuation or ASCII: no hold
      const available = cont + 1;
      if (available < expected) return Math.min(available, SCAN);
    } else {
      // Lead byte with zero continuation yet (cut right after lead).
      const last = buf[buf.length - 1];
      if (last >= 0xC2 && last <= 0xF4) return 1;
    }
    // 2) ESC / CSI / OSC in progress within the scan window.
    for (let i = buf.length - 1; i >= tail; i--) {
      const b = buf[i];
      if (b === 0x1B) {
        // Lone trailing ESC, or ESC-prefixed sequence without terminator.
        // Check whether anything after i forms a complete sequence.
        const rest = buf.subarray(i);
        if (rest.length === 1) return 1;
        if (rest[1] === 0x5B) { // ESC [
          // CSI: needs final byte 0x40-0x7E. If none present, hold from ESC.
          let complete = false;
          for (let j = 2; j < rest.length; j++) {
            if (rest[j] >= 0x40 && rest[j] <= 0x7E) { complete = true; break; }
          }
          if (!complete) return Math.min(rest.length, SCAN);
        } else if (rest[1] === 0x5D) { // ESC ]
          // OSC: needs BEL or ESC \ terminator. If none, hold from ESC.
          let complete = false;
          for (let j = 2; j < rest.length; j++) {
            if (rest[j] === 0x07) { complete = true; break; }
            if (rest[j] === 0x1B && j + 1 < rest.length && rest[j + 1] === 0x5C) { complete = true; break; }
          }
          if (!complete) return Math.min(rest.length, SCAN);
        } else if (rest.length === 2 && (rest[1] === 0x50 || rest[1] === 0x58 || rest[1] === 0x5E || rest[1] === 0x5F)) {
          // DCS/SOS/PM/APC introducer without body yet.
          return Math.min(rest.length, SCAN);
        }
        // Other complete 2-byte ESC sequences (e.g. ESC c, ESC M): no hold.
        return 0;
      }
      if (b === 0x9B) {
        // Single-byte CSI introducer: hold if no final byte follows.
        let complete = false;
        for (let j = i + 1; j < buf.length; j++) {
          if (buf[j] >= 0x40 && buf[j] <= 0x7E) { complete = true; break; }
        }
        if (!complete) return Math.min(buf.length - i, SCAN);
        return 0;
      }
      if (b === 0x9D) {
        // Single-byte OSC introducer: hold if no BEL follows.
        let complete = false;
        for (let j = i + 1; j < buf.length; j++) {
          if (buf[j] === 0x07) { complete = true; break; }
        }
        if (!complete) return Math.min(buf.length - i, SCAN);
        return 0;
      }
    }
    return 0;
  }

  function takeChunkBudget(queue, byteBudget) {
    const budget = Math.max(1, byteBudget || 64 * 1024);
    const selected = [];
    let total = 0;

    while (queue.length && total < budget) {
      const chunk = queue.shift();
      const remaining = budget - total;
      if (chunk.byteLength <= remaining) {
        selected.push(chunk);
        total += chunk.byteLength;
      } else {
        selected.push(chunk.subarray(0, remaining));
        queue.unshift(chunk.subarray(remaining));
        total += remaining;
      }
    }

    let combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of selected) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    // Hold ≤1 frame of trailing partial sequence (never stall: if the hold
    // would empty the frame, emit as-is — progress beats perfection).
    if (combined.length > 1 && queue !== null) {
      const hold = trailingHoldbackLength(combined);
      if (hold > 0 && hold < combined.length) {
        const keep = combined.length - hold;
        queue.unshift(combined.subarray(keep));
        combined = combined.slice(0, keep);
      }
    }
    return combined;
  }

  function appendBoundedText(current, addition, limit) {
    const next = current + addition;
    const slack = Math.min(64 * 1024, Math.max(1, Math.floor(limit / 4)));
    return next.length > limit + slack ? next.slice(-limit) : next;
  }

  return { takeChunkBudget, appendBoundedText, trailingHoldbackLength };
});
