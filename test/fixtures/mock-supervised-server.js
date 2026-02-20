'use strict';

/**
 * Lightweight mock server for supervisor integration tests.
 *
 * Fulfills the supervisor's child contract:
 * - Listens on --port, serves /api/health
 * - Accepts WebSocket connections with create_session, join_session, restart_server
 * - Exits with code 75 on restart_server
 * - Persists sessions to MOCK_SESSION_FILE env var (survives restarts)
 * - Responds to IPC { type: 'shutdown' } with clean exit(0)
 *
 * No PTY, no bridges, no timers — shuts down in <100ms.
 */

const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const portIdx = process.argv.indexOf('--port');
const port = portIdx !== -1 ? parseInt(process.argv[portIdx + 1], 10) : 7777;
const sessionFile = process.env.MOCK_SESSION_FILE || '';

// Load persisted sessions from previous run (if any)
const sessions = new Map();
if (sessionFile) {
  try {
    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    for (const [k, v] of Object.entries(data)) sessions.set(k, v);
  } catch (_) { /* first run or missing file */ }
}

function saveSessions() {
  if (sessionFile) {
    try {
      fs.writeFileSync(sessionFile, JSON.stringify(Object.fromEntries(sessions)));
    } catch (_) { /* ignore */ }
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/health') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404); res.end();
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  const connectionId = uuidv4();
  ws.send(JSON.stringify({ type: 'connected', connectionId, supervised: true }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    switch (msg.type) {
      case 'create_session': {
        const sessionId = uuidv4();
        sessions.set(sessionId, { name: msg.name || 'Unnamed', workingDir: msg.workingDir || '/' });
        saveSessions();
        ws.send(JSON.stringify({ type: 'session_created', sessionId }));
        break;
      }
      case 'join_session': {
        const s = sessions.get(msg.sessionId);
        ws.send(JSON.stringify({
          type: 'session_joined',
          sessionId: msg.sessionId,
          sessionName: s ? s.name : 'Unknown',
          active: false,
          outputBuffer: []
        }));
        break;
      }
      case 'restart_server': {
        // Broadcast restart, save sessions, exit with 75
        wss.clients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) {
            c.send(JSON.stringify({ type: 'server_restarting', reason: 'user_requested' }));
          }
        });
        saveSessions();
        setTimeout(() => {
          wss.close();
          server.close(() => process.exit(75));
          setTimeout(() => process.exit(75), 2000); // hard fallback
        }, 200);
        break;
      }
    }
  });
});

// IPC listener for supervisor-driven shutdown
if (typeof process.send === 'function') {
  process.on('message', (msg) => {
    if (msg && msg.type === 'shutdown') {
      saveSessions();
      wss.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000);
    }
  });
}

server.listen(port, '127.0.0.1', () => {
  console.log(`Mock server listening on port ${port}`);
});
