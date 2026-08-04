'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OutputFrameBatcher = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
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

    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of selected) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  }

  function appendBoundedText(current, addition, limit) {
    const next = current + addition;
    const slack = Math.min(64 * 1024, Math.max(1, Math.floor(limit / 4)));
    return next.length > limit + slack ? next.slice(-limit) : next;
  }

  return { takeChunkBudget, appendBoundedText };
});
