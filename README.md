# OhMyRemote

Control AI coding agents (Claude Code, OpenCode) remotely via Telegram. Run prompts, switch models, monitor sessions, and manage projects — all from your phone.

## Features

- **Telegram Dashboard** — Interactive inline keyboard UI (`/d`) to manage everything with button taps
- **Multi-Engine** — Claude Code CLI and OpenCode support with per-session engine switching
- **Model Selection** — Choose models (Opus/Sonnet/Haiku for Claude, multi-provider for OpenCode) and agents from the dashboard
- **CLI Session Monitor** — Browse and peek into Claude CLI sessions running on your PC without interrupting them
- **Session Management** — Create new sessions, attach to existing CLI sessions, or start fresh
- **Streaming Responses** — Real-time response streaming to Telegram as the AI works
- **Multi-Project** — Switch between projects from the dashboard
- **Unsafe Mode** — Time-limited unsafe tool execution with automatic expiry
- **Job Queue** — Concurrent job execution (up to 3) with lease renewal and failure recovery
- **File Transfer** — Upload/download files to/from project directories
- **Audit Logging** — All commands and runs are logged
- **Dashboard API** — Fastify server with health checks and Prometheus metrics

## Architecture

```
pnpm monorepo
├── apps/
│   ├── bot/          # grammY Telegram bot (long-polling)
│   ├── server/       # Fastify API + dashboard
│   └── web/          # Vite + React dashboard (WIP)
└── packages/
    ├── core/         # Shared types, config schemas, process runner
    ├── engines/      # Claude/OpenCode CLI adapters
    ├── storage/      # SQLite + Drizzle ORM
    └── telegram/     # Command handler, streaming, inline keyboards
```

The bot spawns AI engine processes (`claude -p` or `opencode run`) as child processes, parses their streaming output, and relays events to Telegram in real-time.

## Prerequisites

- Node.js 20+
- pnpm 9+
- Claude Code CLI installed and authenticated (`claude` command available)
- (Optional) OpenCode installed for OpenCode engine support

## Quick Start

```bash
# Install dependencies
pnpm install

# Copy config
cp config/projects.example.json config/projects.json
cp .env.example .env

# Edit .env with your Telegram bot token and owner user ID
# Edit config/projects.json with your project paths

# Run tests
pnpm test

# Type check
pnpm -r run typecheck

# Start bot + server
pnpm start
```

## Configuration

### Setting up Telegram Bot

1. **Create a bot** — Open Telegram, search for [@BotFather](https://t.me/BotFather), send `/newbot`, and follow the prompts. Copy the bot token.

2. **Get your user ID** — Send any message to [@userinfobot](https://t.me/userinfobot). It will reply with your numeric user ID. This ID restricts the bot so only you can control it.

3. **Configure `.env`** — Copy the example and fill in your values:

```bash
cp .env.example .env
```

```env
# Required
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234...    # from @BotFather
TELEGRAM_OWNER_USER_ID=987654321            # from @userinfobot

# Optional
DATA_DIR=./data                              # SQLite database location
PROJECTS_CONFIG_PATH=./config/projects.json  # project list path
DASHBOARD_PORT=4312                          # web dashboard port
DASHBOARD_BIND_HOST=127.0.0.1               # bind address (localhost only)
# DASHBOARD_BASIC_AUTH_USER=admin            # dashboard basic auth
# DASHBOARD_BASIC_AUTH_PASS=password
# KILL_SWITCH_DISABLE_RUNS=false             # emergency stop for all runs
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Telegram Bot API token from @BotFather |
| `TELEGRAM_OWNER_USER_ID` | Yes | — | Your Telegram numeric user ID (only this user can control the bot) |
| `DATA_DIR` | No | `./data` | SQLite database storage directory |
| `PROJECTS_CONFIG_PATH` | No | `./config/projects.json` | Path to projects configuration |
| `DASHBOARD_PORT` | No | `4312` | Fastify dashboard port |
| `DASHBOARD_BIND_HOST` | No | `127.0.0.1` | Dashboard bind address |
| `DASHBOARD_BASIC_AUTH_USER` | No | — | Basic auth username for dashboard |
| `DASHBOARD_BASIC_AUTH_PASS` | No | — | Basic auth password for dashboard |
| `KILL_SWITCH_DISABLE_RUNS` | No | `false` | Emergency kill switch to disable all runs |

### Projects Configuration

```json
[
  {
    "id": "my-project",
    "name": "My Project",
    "rootPath": "/home/user/projects/my-project",
    "defaultEngine": "claude"
  },
  {
    "id": "opencode-project",
    "name": "OpenCode Project",
    "rootPath": "/home/user/projects/opencode-project",
    "defaultEngine": "opencode",
    "opencodeAttachUrl": "http://localhost:3000"
  }
]
```

## Telegram Dashboard

Send `/d` or `/dashboard` to open the interactive control panel:

```
📋 OhMyRemote Dashboard

Project: My Project
Engine:  claude
Model:   default
Session: new
Unsafe:  OFF

[ My Project ✅ ] [ Other Project ]
[ claude ✓ ] [ opencode ]
[ 🧠 Model: default ]
[ 🆕 New Session ] [ 💻 Sessions ]
[ ⚠️ Unsafe 30m ] [ ⚠️ Unsafe 60m ] [ 🔒 Safe ]
[ 🔄 Refresh ]
```

All buttons update the same message in-place. After configuring, just send a text message to execute it as a prompt.

### Dashboard Actions

| Button | Action |
|--------|--------|
| Project buttons | Switch active project |
| Engine toggle | Switch between Claude and OpenCode |
| Model | Open model/agent selection submenu |
| New Session | Start a fresh AI session |
| Sessions | Browse CLI sessions — peek activity or attach |
| Unsafe | Enable time-limited unsafe tool execution |
| Refresh | Reload dashboard state |

### CLI Session Monitor

The **Sessions** button scans `~/.claude/projects/` for Claude CLI sessions in the selected project. Each session shows:

- First prompt (conversation topic)
- Last activity time

Selecting a session opens a **peek view** showing recent activity (user messages, assistant responses, tool calls) without disturbing the running session. You can then **attach** to continue the conversation remotely.

## Text Commands

All original text commands still work alongside the dashboard:

| Command | Description |
|---------|-------------|
| `/d`, `/dashboard` | Open interactive dashboard |
| `/projects` | List configured projects |
| `/use <id>` | Select a project |
| `/engine <claude\|opencode>` | Set default engine |
| `/newsession <engine> [name]` | Create a new session |
| `/run <text>` | Execute a prompt |
| `/continue [text]` | Continue the most recent session |
| `/attach <session_id>` | Attach to a specific engine session |
| `/stop` | Cancel the current run |
| `/status` | Show current state |
| `/enable_unsafe <minutes>` | Enable unsafe mode |
| `/uploads` | List recent uploads |
| `/get <path>` | Download a file from the project |
| `/help` | Show all commands |

## Deployment

### macOS launchd

```bash
# Install as persistent background services
sed -e "s|__PROJECT_ROOT__|$PWD|g" \
    -e "s|__PNPM_BIN__|$(command -v pnpm)|g" \
    deploy/macos/launchd/server.plist > ~/Library/LaunchAgents/ai.ohmyremote.server.plist

sed -e "s|__PROJECT_ROOT__|$PWD|g" \
    -e "s|__PNPM_BIN__|$(command -v pnpm)|g" \
    deploy/macos/launchd/bot.plist > ~/Library/LaunchAgents/ai.ohmyremote.bot.plist

launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.ohmyremote.server.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.ohmyremote.bot.plist
```

Logs: `/tmp/ohmyremote-{server,bot}.{out,err}.log`

### Private Access via Tailscale

Keep the dashboard bound to loopback and expose via Tailscale:

```bash
tailscale serve http://127.0.0.1:4312
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+ / TypeScript 5.9 |
| Monorepo | pnpm workspaces |
| Bot | grammY |
| API | Fastify 5 |
| Database | SQLite + Drizzle ORM |
| Validation | Zod |
| AI Engines | Claude Code CLI, OpenCode CLI |

## License

MIT
