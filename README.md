# Cortex

Universal AI coding terminal — Claude, Copilot, Gemini & more in your browser.

Cortex is a web-based terminal aggregator that provides browser access to multiple AI CLI tools through a unified interface. Launch Claude, GitHub Copilot, Google Gemini, OpenAI Codex, or a raw terminal session — all from one place, with multi-session support and real-time streaming.

## Features

- **Multi-tool support** — Claude, Copilot, Gemini, Codex, and raw terminal in one interface
- **Dynamic tool detection** — automatically discovers which tools are installed
- **Real-time streaming** — full terminal emulation via xterm.js with 256-color support
- **Multi-session** — run multiple sessions in browser tabs, switch between them
- **Multi-device** — same session accessible from different browsers/devices
- **Session persistence** — sessions survive server restarts
- **Authentication** — token-based auth enabled by default
- **Dev Tunnels** — secure remote access via Microsoft Dev Tunnels
- **Cross-platform** — works on Linux and Windows (ConPTY)
- **PWA** — installable as a Progressive Web App
- **Mobile-friendly** — responsive design with touch-optimized controls

## Requirements

- Node.js >= 16
- At least one supported CLI tool installed:
  - [Claude Code](https://claude.ai/code) — `claude`
  - [GitHub Copilot CLI](https://github.com/features/copilot/cli) — `copilot`
  - [Google Gemini CLI](https://github.com/google-gemini/gemini-cli) — `gemini`
  - [OpenAI Codex](https://openai.com/codex) — `codex`
  - Terminal is always available (bash/PowerShell)

## Quick Start

```bash
# Install globally
npm install -g cortex

# Run (auto-generates auth token)
cortex

# Or run without installing
npx cortex
```

## Usage

```bash
# Start with default settings
cortex

# Custom port
cortex --port 8080

# With specific auth token
cortex --auth your-secret-token

# Development mode (extra logging)
cortex --dev

# HTTPS mode
cortex --https --cert cert.pem --key key.pem

# Remote access via Dev Tunnels
cortex --tunnel --tunnel-allow-anonymous

# Custom tool aliases
cortex --claude-alias "AI" --copilot-alias "CP" --gemini-alias "Gem"

# Disable auth (not recommended for production)
cortex --disable-auth
```

## CLI Options

| Flag | Description | Default |
|------|-------------|---------|
| `-p, --port <number>` | Server port | `7777` |
| `--no-open` | Don't auto-open browser | |
| `--auth <token>` | Set auth token | auto-generated |
| `--disable-auth` | Disable authentication | |
| `--https` | Enable HTTPS | |
| `--cert <path>` | SSL certificate file | |
| `--key <path>` | SSL private key file | |
| `--dev` | Development mode | |
| `--plan <type>` | Subscription plan (pro, max5, max20) | `max20` |
| `--tunnel` | Enable Dev Tunnel | |
| `--tunnel-allow-anonymous` | Allow anonymous tunnel access | |
| `--claude-alias <name>` | Display name for Claude | `Claude` |
| `--codex-alias <name>` | Display name for Codex | `Codex` |
| `--copilot-alias <name>` | Display name for Copilot | `Copilot` |
| `--gemini-alias <name>` | Display name for Gemini | `Gemini` |
| `--terminal-alias <name>` | Display name for Terminal | `Terminal` |

## Dev Tunnels Setup

For remote access, Cortex uses [Microsoft Dev Tunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/):

```bash
# Install devtunnel CLI
# Windows:
winget install Microsoft.devtunnel

# Linux:
curl -sL https://aka.ms/DevTunnelCliInstall | bash

# First-time login (one-time)
devtunnel user login

# Then start Cortex with tunnel
cortex --tunnel --tunnel-allow-anonymous
```

## Supported Tools

| Tool | Command | Install |
|------|---------|---------|
| Claude | `claude` | [claude.ai/code](https://claude.ai/code) |
| Copilot | `copilot` | `npm install -g @github/copilot` or `winget install GitHub.Copilot` |
| Gemini | `gemini` | `npm install -g @google/gemini-cli` |
| Codex | `codex` | [openai.com/codex](https://openai.com/codex) |
| Terminal | bash/PowerShell | Always available |

Tools that aren't installed appear as disabled in the UI. Install them at any time — Cortex detects them on next startup.

## Architecture

See [docs/](docs/README.md) for full technical documentation:

- [System Overview](docs/architecture/overview.md)
- [WebSocket Protocol](docs/architecture/websocket-protocol.md)
- [Bridge Pattern](docs/architecture/bridge-pattern.md)
- [Architecture Decision Records](docs/adrs/)

## Development

```bash
# Clone and install
git clone https://github.com/animeshkundu/cortex.git
cd cortex
npm install

# Run in dev mode
npm run dev

# Run tests
npm test
```

## API

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Server health check |
| `GET` | `/api/config` | Server config + tool availability |
| `GET` | `/api/sessions/list` | List all sessions |
| `POST` | `/api/sessions/create` | Create a new session |
| `DELETE` | `/api/sessions/:id` | Delete a session |
| `GET` | `/api/folders` | Browse directories |

### WebSocket

Connect to `ws://localhost:7777?token=<auth-token>` for real-time communication. See [WebSocket Protocol docs](docs/architecture/websocket-protocol.md) for the full message reference.

## License

MIT
