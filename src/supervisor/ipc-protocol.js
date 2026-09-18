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

module.exports = {
  MSG,
  isValidFrame,
  shutdown,
  handoffStart,
  ready,
  shutdownComplete,
  handoffComplete,
  updateReady,
};
