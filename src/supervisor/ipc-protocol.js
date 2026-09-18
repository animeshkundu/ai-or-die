'use strict';

// Supervisor <-> Server IPC protocol for zero-downtime PTY handoff.
//
// Transport: the Node IPC channel (child.send / process.on('message')) for
// control frames, plus fd/handle passing where the platform supports it:
//   - POSIX: SCM_RIGHTS over a Unix-domain-socket pair shared at spawn
//     (fd 4 in the child). Node's child.send(message, handle) covers
//     net.Socket handles; raw PTY fds travel over the socket pair.
//   - Windows: CreateProcess handle inheritance via
//     PROC_THREAD_ATTRIBUTE_HANDLE_LIST (koffi FFI); Job Object membership
//     is re-applied by the supervisor after spawn.
//
// Every frame is { type, ...payload }. Unknown types are ignored so old and
// new binaries interoperate during a staggered fleet rollout.

const MSG = {
  // Supervisor -> Server
  SHUTDOWN: 'shutdown',               // { reason: 'update'|'restart'|'user' }
  HANDOFF_START: 'handoff_start',     // { ptys: [{ ptyId, bridgeType, pid }] }
  CONFIG_UPDATE: 'config_update',     // { config }
  // Server -> Supervisor
  READY: 'ready',                     // { pid, sessionCount, version }
  SHUTDOWN_COMPLETE: 'shutdown_complete', // { savedSessions }
  HANDOFF_COMPLETE: 'handoff_complete',   // { receivedPtys }
  STATUS: 'status',                   // { rss, sessions, uptime }
  ERROR: 'error',                     // { code, message }
  UPDATE_READY: 'update_ready',       // { version } (supervisor -> server -> UI broadcast)
  // Update-API round-trips (child Server -> parent Supervisor). Every
  // request carries a numeric `id`; the supervisor replies with the matching
  // response type + same `id`. Unknown types are ignored, so old and new
  // binaries interoperate (a request to an old supervisor simply times out
  // on the child instead of breaking the swap path).
  UPDATE_STATUS_REQUEST: 'update_status_request',   // { id }
  UPDATE_STATUS_RESPONSE: 'update_status_response', // { id, ok, result|error }
  UPDATE_CHECK_REQUEST: 'update_check_request',     // { id }
  UPDATE_CHECK_RESPONSE: 'update_check_response',   // { id, ok, result|error }
  // NB: the apply request type predates the id convention and keeps its
  // wire string so old/new binaries interoperate. New children attach `id`
  // and await UPDATE_APPLY_RESPONSE; legacy fire-and-forget senders (no id)
  // keep the old behavior (no reply).
  UPDATE_APPLY_REQUEST: 'update_apply_request',     // { id? }
  UPDATE_APPLY_RESPONSE: 'update_apply_response',   // { id, ok, result|error }
};

function isValidFrame(msg) {
  return !!msg && typeof msg === 'object' && typeof msg.type === 'string';
}

function shutdown(reason) {
  return { type: MSG.SHUTDOWN, reason };
}

function handoffStart(ptys) {
  return { type: MSG.HANDOFF_START, ptys };
}

function ready(pid, sessionCount, version) {
  return { type: MSG.READY, pid, sessionCount, version };
}

function shutdownComplete(savedSessions) {
  return { type: MSG.SHUTDOWN_COMPLETE, savedSessions: !!savedSessions };
}

function handoffComplete(receivedPtys) {
  return { type: MSG.HANDOFF_COMPLETE, receivedPtys };
}

function updateReady(version) {
  return { type: MSG.UPDATE_READY, version };
}

function updateStatusRequest(id) {
  return { type: MSG.UPDATE_STATUS_REQUEST, id };
}

function updateStatusResponse(id, ok, resultOrError) {
  return ok
    ? { type: MSG.UPDATE_STATUS_RESPONSE, id, ok: true, result: resultOrError }
    : { type: MSG.UPDATE_STATUS_RESPONSE, id, ok: false, error: resultOrError };
}

function updateCheckRequest(id) {
  return { type: MSG.UPDATE_CHECK_REQUEST, id };
}

function updateCheckResponse(id, ok, resultOrError) {
  return ok
    ? { type: MSG.UPDATE_CHECK_RESPONSE, id, ok: true, result: resultOrError }
    : { type: MSG.UPDATE_CHECK_RESPONSE, id, ok: false, error: resultOrError };
}

function updateApplyRequest(id) {
  return { type: MSG.UPDATE_APPLY_REQUEST, id };
}

function updateApplyResponse(id, ok, resultOrError) {
  return ok
    ? { type: MSG.UPDATE_APPLY_RESPONSE, id, ok: true, result: resultOrError }
    : { type: MSG.UPDATE_APPLY_RESPONSE, id, ok: false, error: resultOrError };
}

module.exports = {
  MSG,
  isValidFrame,
  shutdown,
  handoffStart,
  ready,
  shutdownComplete,
  handoffComplete,
  updateReady,
  updateStatusRequest,
  updateStatusResponse,
  updateCheckRequest,
  updateCheckResponse,
  updateApplyRequest,
  updateApplyResponse,
};
