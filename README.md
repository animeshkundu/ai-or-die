<p align="center">
  <h1 align="center">ai-or-die</h1>
  <p align="center">
    Universal AI coding terminal — Claude, Copilot, Gemini, Codex & raw terminal in one browser UI.
  </p>
</p>

<p align="center">
  <a href="https://github.com/animeshkundu/ai-or-die/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/animeshkundu/ai-or-die/ci.yml?branch=main&label=CI&style=flat-square" alt="CI"></a>
  <a href="https://www.npmjs.com/package/ai-or-die"><img src="https://img.shields.io/npm/v/ai-or-die?style=flat-square&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/ai-or-die"><img src="https://img.shields.io/npm/dm/ai-or-die?style=flat-square" alt="npm downloads"></a>
  <a href="https://github.com/animeshkundu/ai-or-die/blob/main/LICENSE"><img src="https://img.shields.io/github/license/animeshkundu/ai-or-die?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/node/v/ai-or-die?style=flat-square" alt="Node.js version">
  <a href="https://github.com/animeshkundu/ai-or-die/stargazers"><img src="https://img.shields.io/github/stars/animeshkundu/ai-or-die?style=flat-square" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="https://animesh.kundus.in/ai-or-die/">Website</a> &middot;
  <a href="https://www.npmjs.com/package/ai-or-die">npm</a> &middot;
  <a href="https://github.com/animeshkundu/ai-or-die/releases">Releases</a>
</p>

---

```bash
npx ai-or-die
```

One command. Opens your browser. Every AI coding assistant you have installed, ready to go.

---

## Why ai-or-die?

You have Claude Code, GitHub Copilot CLI, Gemini CLI, and OpenAI Codex all installed — but you can only use one terminal at a time. **ai-or-die** gives you a single browser-based workspace where you can run them all, side by side, in tabbed sessions with full terminal emulation.

No config files. No Docker. No complex setup. Just `npx ai-or-die` and start coding.

## Features

| Feature | Details |
|---|---|
| **Multi-tool** | Claude, Copilot, Gemini, Codex, Terminal — auto-detects what's installed |
| **Multi-session** | Tabbed browser sessions — run different tools in parallel |
| **Real-time** | xterm.js + WebSocket streaming with full 256-color terminal emulation |
| **Secure by default** | Auto-generated auth token embedded in URL — one click to open |
| **Remote access** | Dev Tunnels via `--tunnel` — auto-login, named tunnels per machine |
| **Multi-device** | Same session accessible from phone, tablet, or another machine |
| **Persistent sessions** | Sessions survive server restarts — output buffer saved to disk |
| **Cross-platform** | Windows (ConPTY) + Linux — tested in CI on both |
| **PWA** | Installable web app with offline-capable shell |
| **Standalone binaries** | Pre-built binaries for Linux x64 and Windows x64 — no Node.js required |
| **Voice input** | Speak instead of type — cloud (Chrome/Edge) or local (private, offline) |

## Voice Input

Speak instead of type. Voice input supports two modes:

- **Cloud mode** (Chrome/Edge) — uses the browser's built-in speech recognition. Instant, zero download. Always available on Chromium browsers.
- **Local mode** (`--stt` flag) — runs Parakeet V3 speech-to-text on your machine via sherpa-onnx. Fully private, works offline.

### Enabling Local Mode

```bash
ai-or-die --stt
```

On first use, the ~670MB model downloads automatically (cached at `~/.ai-or-die/models/`). The app remains fully usable during download.

### Usage

- Click the **mic button** in the toolbar, or press **Ctrl+Shift+M** to start/stop recording.
- **Hold** Ctrl+Shift+M for push-to-talk (release to transcribe).
- Press **Escape** to cancel a recording.
- Transcribed text appears in the terminal input — review, edit, then press Enter.

### Configuration

| Flag | Description |
|------|-------------|
| `--stt` | Enable local speech-to-text |
| `--stt-endpoint <url>` | Use an external OpenAI-compatible STT endpoint |
| `--stt-model-dir <path>` | Custom model storage directory |
| `--stt-threads <number>` | CPU threads for inference (default: auto, max 4) |

## Quick Start

### Via npx (recommended)

```bash
npx ai-or-die
```

Requires **Node.js 22+**. Opens `http://localhost:7777` with a secure token in the URL.

### Global install

```bash
npm install -g ai-or-die
ai-or-die
```

### Standalone binary

Download from [Releases](https://github.com/animeshkundu/ai-or-die/releases) — no Node.js needed.

| Platform | Binary |
|----------|--------|
| Linux x64 | `ai-or-die-linux-x64` |
| Windows x64 | `ai-or-die-windows-x64.exe` |

## Usage

```bash
# Default — prints the URL (with secure token); does NOT auto-open a browser
ai-or-die

# Open the browser automatically on start
ai-or-die --open

# Custom port
ai-or-die --port 8080

# Explicit auth token
ai-or-die --auth my-secret-token

# Remote access via Dev Tunnel
ai-or-die --tunnel

# HTTPS
ai-or-die --https --cert cert.pem --key key.pem

# Development mode (verbose logging)
ai-or-die --dev

# Custom tool display names
ai-or-die --claude-alias "Sonnet" --gemini-alias "Gem"

# Enable local voice-to-text (private, offline)
ai-or-die --stt
```

## CLI Reference

| Flag | Description | Default |
|------|-------------|---------|
| `-p, --port <number>` | Server port | `7777` |
| `--auth <token>` | Set auth token | auto-generated |
| `--disable-auth` | Disable authentication | `false` |
| `--tunnel` | Enable Microsoft Dev Tunnel | `false` |
| `--tunnel-allow-anonymous` | Allow anonymous tunnel access | `false` |
| `--https` | Enable HTTPS (auto-generates a self-signed cert if `--cert`/`--key` not given) | `false` |
| `--cert <path>` | SSL certificate file | |
| `--key <path>` | SSL private key file | |
| `--dev` | Verbose logging | `false` |
| `--open` | Open the browser on start (never on supervised restart) | `false` |
| `--plan <type>` | Subscription plan (`pro`, `max5`, `max20`) | `max20` |
| `--stt` | Enable local speech-to-text | `false` |
| `--stt-endpoint <url>` | External STT endpoint (OpenAI-compatible) | |
| `--stt-model-dir <path>` | Custom model directory | `~/.ai-or-die/models/` |
| `--stt-threads <number>` | CPU threads for STT inference | auto (max 4) |

## Supported Tools

| Tool | Command | Install |
|------|---------|---------|
| Claude Code | `claude` | [claude.ai/code](https://claude.ai/code) |
| GitHub Copilot | `copilot` | [github.com/features/copilot](https://github.com/features/copilot) |
| Google Gemini | `gemini` | [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) |
| OpenAI Codex | `codex` | [openai.com/codex](https://openai.com/codex) |
| Terminal | bash / PowerShell | Always available |

Tools that aren't installed appear as disabled in the UI. Install any of them at any time — ai-or-die detects them on startup.

## Dev Tunnels

For secure remote access, ai-or-die integrates with [Microsoft Dev Tunnels](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/). Each machine gets a persistent named tunnel based on hostname.

```bash
# Install devtunnel CLI (one-time)
winget install Microsoft.devtunnel        # Windows
curl -sL https://aka.ms/DevTunnelCliInstall | bash  # Linux

# Start with tunnel (auto-login if needed)
ai-or-die --tunnel
```

When `--tunnel` is active, auth is disabled — the tunnel itself controls access.

## Install as a PWA

ai-or-die is an installable progressive web app. Open Settings → Install in the app, or use the install icon in your browser's address bar. The installed app runs in its own window with offline-capable shell caching.

**Browser support**: Chrome / Edge / Samsung Internet support one-tap install. Firefox desktop does not have native install — use the browser menu to pin the tab. Safari iOS uses Share → Add to Home Screen.

**Installing on LAN devices**: Browsers refuse to install PWAs over an HTTPS origin whose certificate isn't trusted by the device, and public CAs (Let's Encrypt etc.) won't issue certs for a LAN IP or `localhost`. The `--https` self-signed cert therefore triggers a browser warning, and the in-app Install panel will say *"Not available in this browser."* on a LAN IP. Ways to get an installable origin:

1. **On the host machine itself** — just open **`http://localhost:<port>`**. `localhost` is a secure context, so the PWA installs with **no cert and no setup** (no `--https` needed).
2. **On other devices** — use **`--tunnel`** *(recommended)*: Microsoft Dev Tunnels gives a public URL with a real publicly-trusted cert, so any device installs the PWA with **no per-device setup and no admin**.
3. **Bring your own trusted cert** via `--cert` / `--key` (e.g. a cert for a hostname your devices already trust).

See [docs/history/pwa-install-lan-self-signed-cert.md](docs/history/pwa-install-lan-self-signed-cert.md) for the underlying browser-policy reasoning.

See [docs/history/pwa-install-lan-self-signed-cert.md](docs/history/pwa-install-lan-self-signed-cert.md) for the device-by-device procedure and the underlying browser-policy reasoning.

## Architecture

```
Browser (xterm.js)
   |
   | WebSocket
   v
Express Server ──> Session Store (~/.ai-or-die/sessions.json)
   |
   | node-pty
   v
Claude / Copilot / Gemini / Codex / bash
```

- **Server** (`src/server.js`) — Express + WebSocket, session persistence, auth, rate limiting
- **Bridges** (`src/*-bridge.js`) — Spawn CLI processes via node-pty, output buffering
- **Client** (`src/public/`) — Vanilla JS + xterm.js, tabbed sessions, PWA
- **Tunnel** (`src/tunnel-manager.js`) — devtunnel lifecycle, auto-login, auto-restart

See [docs/](docs/) for [ADRs](docs/adrs/), [specs](docs/specs/), and [architecture diagrams](docs/architecture/).

## Development

```bash
git clone https://github.com/animeshkundu/ai-or-die.git
cd ai-or-die
npm install
npm run dev     # start with verbose logging
npm test        # run tests
npm run build:sea  # build standalone binary
```

## Contributing

1. Check [ADRs](docs/adrs/) before proposing architectural changes
2. Update [specs](docs/specs/) when changing component behavior
3. Add tests for every feature and bug fix
4. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`, `chore:`)

## License

[MIT](LICENSE) — Animesh Kundu
