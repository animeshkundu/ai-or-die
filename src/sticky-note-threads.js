'use strict';

// Thread-count policy for the sticky-note inference worker. Pure + dependency-
// free so it can be unit-tested without spawning a worker or loading a model.
//
// The worker decides its own thread count AFTER getLlama() reports whether a GPU
// backend actually loaded:
//   - GPU present  -> the GPU carries the inference (the worker also requests full
//     layer offload); keep a low, gentle CPU thread count so it can't saturate CPU
//     and starve the terminal / AI agent.
//   - No GPU (CPU) -> common on Windows when the Vulkan/CUDA prebuilt binary is
//     incompatible. At 2 threads one grammar-constrained summary takes ~160s on a
//     16-core box and blows every timeout; use THREE-QUARTERS of the cores (leaving
//     a quarter for the terminal/agent) so it completes well inside the watchdog.
// An explicit override (--sticky-notes-threads) always wins, after validation.
// `explicit` is coerced with Number() so a numeric string (e.g. from a CLI/env
// arg) still counts as a valid pin rather than silently falling back to auto.
function pickThreads({ explicit, gpu, cpus } = {}) {
  const pinned = Number(explicit);
  if (Number.isFinite(pinned) && pinned > 0) return Math.floor(pinned);
  const cores = Number.isFinite(cpus) && cpus > 0 ? Math.floor(cpus) : 1;
  return gpu ? Math.max(1, Math.min(2, cores - 2)) : Math.max(1, Math.floor((cores * 3) / 4));
}

module.exports = { pickThreads };
