# Ctrl+C SIGABRT from native worker teardown (2026-06)

## Symptom

Starting the app with `node bin/ai-or-die.js` or `npm start` and pressing
Ctrl+C aborted the process with signal 6 (`SIGABRT`, shell exit 134). The
terminal printed:

```text
libc++abi: terminating due to uncaught exception of type Napi::Error
```

The failure could happen during startup while models were still loading, or after
startup with both local engines enabled. It affected the direct server path and
the supervised path.

## Root cause

The app runs two ggml-based native addons on Node `worker_threads`: local STT via
`sherpa-onnx-node` and sticky-note summaries via `node-llama-cpp`. On Ctrl+C, the
workers could be force-torn-down by `process.exit()` while a native model was
loaded or still loading. An uncaught `Napi::Error` during worker-environment
teardown was converted into `SIGABRT` because ggml installs a process-wide
`std::set_terminate(ggml_uncaught_exception)` handler.

Contributing factors:

1. `bin/ai-or-die.js` registered a second SIGINT/SIGTERM handler that called
   `httpServer.close()` and then `process.exit(0)`, racing the server's graceful
   `ClaudeCodeWebServer.handleShutdown` path.
2. `handleShutdown` did not shut down the STT engine, so the sherpa-onnx worker
   could survive until process teardown.
3. The sticky-note worker disposed its context and model but not the top-level
   `llama` backend.

The abort risk is cross-platform because ggml's terminate handler is
process-wide. On Windows, the same forced teardown also risked leaving the GGUF
model file locked, which is especially relevant for the primary deployment
target.

## Fix

- Removed the duplicate signal handler from `bin/ai-or-die.js`. The server's
  single `ClaudeCodeWebServer.handleShutdown` handler now owns SIGINT/SIGTERM
  and also stops the `--tunnel` `TunnelManager`.
- `handleShutdown` saves sessions early, then tears down sticky notes, STT, and
  the tunnel concurrently with `Promise.allSettled`. It then closes the HTTP
  server and exits. A 15 s force-exit timer remains the hard backstop.
- Both engines now shut down workers cooperatively. They set `_stopping`, track a
  worker from creation via `_spawningWorker`, stop spawning once shutdown begins,
  wait on a bounded shared deadline of about 10 s for in-flight model loads, post
  `{type:'shutdown'}`, and await the worker's own clean exit.
- Neither engine calls `worker.terminate()`. Force-killing a worker inside
  ggml-backed native code can abort the whole process.
- A worker that becomes ready after shutdown has started is not adopted.
- Worker threads release native state before exiting. Sticky notes dispose
  context, model, and then the top-level `llama` backend. STT has no sherpa-onnx
  dispose API, so its worker exits cleanly while idle after the shutdown message.

## Verification

Verification covered process-group signals, matching a real terminal Ctrl+C:

- `SIGINT` during startup at settle times from 0.3 s through 5 s exits 0 with no
  `libc++abi`, `ggml_uncaught`, or `Napi::Error` markers.
- The same coverage passes on the direct path (`node bin/ai-or-die.js`) and the
  supervised path (`node bin/supervisor.js`) with both local engines enabled.
- `SIGTERM` follows the same clean shutdown path.
- 1402 unit tests pass.

## Lessons

- One process should have one shutdown owner. A second signal handler that calls
  `process.exit()` can preempt the graceful path and invalidate cleanup
  ordering.
- Native-addon workers need cooperative shutdown. `worker.terminate()` is not a
  safe fallback when a ggml-backed model may be loaded or loading.
- Treat a loading worker as owned from construction time. Shutdown must cover the
  loading, ready, idle, and late-ready states.
- Dispose the top-level native backend, not only child objects. On Windows, file
  lock release is part of the shutdown contract.
