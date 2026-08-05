'use strict';

const http = require('http');

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 9100;

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write(`Invalid --port value: ${args[portIndex + 1] || ''}\n`);
  process.exit(2);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('VS Code test server');
});

server.on('error', (err) => {
  process.stderr.write(`${err.code || 'ERROR'}: ${err.message}\n`);
  process.exitCode = 1;
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Web UI available at http://localhost:${port}\n`);
});

function close() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', close);
process.on('SIGTERM', close);
