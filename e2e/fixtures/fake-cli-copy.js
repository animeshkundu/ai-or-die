'use strict';

const tool = String(process.argv[2] || '').toLowerCase();
const labels = {
  claude: 'Claude Code',
  copilot: 'GitHub Copilot',
};

if (!labels[tool]) {
  process.stderr.write('Usage: fake-cli-copy.js <claude|copilot>\n');
  process.exit(2);
}

const marker = `COPY_E2E_${tool.toUpperCase()}_CLI`;
const label = labels[tool];
const wrappedLine = `${marker}_WRAPPED_${'0123456789abcdef'.repeat(24)}`;
const ansiLine = `${marker}_ANSI_FULL_SCREEN`;

// Deliberately paint a small alternate-screen-style TUI in separate writes.
// The long alphanumeric row must wrap at both desktop and mobile terminal
// widths; the copy tests assert that it comes back as one logical line with
// ANSI colour/control sequences removed.
process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
setTimeout(() => {
  process.stdout.write(`\x1b[36m${label} CLI fixture ready\x1b[0m\r\n`);
}, 10);
setTimeout(() => {
  process.stdout.write(`\x1b[1;33m${wrappedLine}\x1b[0m\r\n`);
}, 30);
setTimeout(() => {
  process.stdout.write(`\x1b[1;32m${ansiLine}\x1b[0m\r\n`);
}, 50);
setTimeout(() => {
  process.stdout.write('\x1b[?25h');
}, 70);

process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));
process.stdin.resume();
setInterval(() => {}, 0x7fffffff);
