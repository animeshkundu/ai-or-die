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

process.stdout.write(`${label} CLI fixture ready\r\n`);
process.stdout.write(`${marker}\r\n`);
process.stdout.write('Visible terminal output is ready to copy.\r\n');

process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));
process.stdin.resume();
setInterval(() => {}, 0x7fffffff);
