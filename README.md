# RemoteClaw

**AI Coding Agent: Chat → Code → Build → Preview → Verify**

RemoteClaw is a self-hostable agent orchestrator that bridges Telegram to Claude Code SDK. Send a message, get code changes — committed, deployed, and previewed — all from your phone.

```
You (Telegram/desktop app)  →  RemoteClaw  →  Claude Code SDK  →  Your Codebase
                                                          ↓
              Preview URL  ←  Tunnel  ←  Dev Server  ←  Build
```

## Features

- **Multi-project** — manage multiple codebases with per-project agent profiles (different models, budgets, system prompts)
- **6-stage pipeline** — Context → Execute → Commit → Deploy → Record → Notify, with before/after hooks at each stage
- **Built-in skills** — `/deploy`, `/review`, `/test`, `/fix`, `/explain`, `/refactor` — extensible via SKILL.md files
- **3-tier memory** — session (L0), project (L1), cross-project (L2) stored in SQLite
- **Live preview** — automatic tunnel via ngrok or cloudflared with health checks
- **Cron jobs** — scheduled shell commands, agent prompts, health checks, and git pulls
- **No API key needed** — uses your existing Claude Code CLI authentication
- **No Docker needed** — runs directly on your machine as a single Node.js process

## Quick Start

### Prerequisites

- Node.js >= 20
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- A Telegram bot token (get one from [@BotFather](https://t.me/BotFather))

### Installation

```bash
git clone https://github.com/hale249/remoteclaw.git
cd remoteclaw
npm install
```

### Configuration

```bash
cp config/remoteclaw.example.yaml config/remoteclaw.yaml
```

Edit `config/remoteclaw.yaml`:

```yaml
channels:
  telegram:
    bot_token: ${TELEGRAM_BOT_TOKEN}
    mode: polling

auth:
  allowed_telegram_ids:
    - 123456789          # your Telegram user ID
  admin_telegram_ids:
    - 123456789

agents:
  default:
    model: claude-sonnet-4-20250514
    max_budget_usd: 5.0
    max_turns: 50

projects:
  my-app:
    path: /path/to/your/project
    port: 3000
    build: npm run build
    dev: npm run dev
    agent: default
```

Create a `.env` file:

```env
TELEGRAM_BOT_TOKEN=your-bot-token-here
```

### Run

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## How It Works

```
1. You send "Add /products API" on Telegram
2. ContextStage  → injects CLAUDE.md + project memory + cross-project memory
3. ExecuteStage  → Claude Code SDK generates code changes
4. CommitStage   → git diff → hooks → git commit
5. DeployStage   → build → dev server → health check → tunnel
6. RecordStage   → save to SQLite + write memory
7. NotifyStage   → reply on Telegram with summary, commit hash, cost, preview URL
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/projects` | List all configured projects |
| `/switch <slug>` | Switch active project |
| `/preview` | Show current preview URL |
| `/status` | Show project details |
| `/agents` | List agent profiles |
| `/skills` | List available skills |
| `/memory` | View project memory |
| `/memory add <note>` | Add a note to memory |
| `/memory clear` | Clear project memory |
| `/cron` | Show scheduled jobs |
| `/cost` | Show today's spending |
| *free text* | Run as a task prompt |

## Agent Profiles

Define multiple agent profiles with different models, budgets, and behaviors:

```yaml
agents:
  default:
    model: claude-sonnet-4-20250514
    max_budget_usd: 5.0
    max_turns: 50

  senior-java:
    model: claude-opus-4-20250514
    system_prompt: |
      You are a senior Java/Spring Boot developer.
      Use constructor injection, not @Autowired.
    max_budget_usd: 10.0
    max_turns: 80

  reviewer:
    model: claude-sonnet-4-20250514
    system_prompt: |
      You are a code reviewer.
      Never edit files. Only report issues.
    max_budget_usd: 2.0
    allowed_tools: [Read, Glob, Grep]   # read-only
```

## Skills

Built-in skills are invoked via Telegram commands:

| Skill | Trigger | Description |
|-------|---------|-------------|
| Deploy | `/deploy` | Build and expose via tunnel |
| Review | `/review` | Code review (read-only) |
| Test | `/test` | Run tests and report results |
| Fix | `/fix <description>` | Fix a bug from description |
| Explain | `/explain <file or concept>` | Explain code or architecture |
| Refactor | `/refactor <description>` | Guided refactoring |

### Custom Skills

Create a `SKILL.md` file in any of these locations (highest priority first):

1. `<project>/.remoteclaw/skills/my-skill/SKILL.md`
2. `~/.remoteclaw/skills/my-skill/SKILL.md`
3. `skills/my-skill/SKILL.md` (built-in)

```markdown
---
name: my-skill
description: Does something useful
trigger: /my-skill
agent: default
skip_commit: true
---

Instructions for the agent when this skill is triggered...
```

## Cron Jobs

Schedule automated tasks:

```yaml
cron:
  jobs:
    auto-test:
      project: my-app
      schedule:
        type: interval
        interval: 30m
      action:
        type: shell
        command: "npm test"

    daily-review:
      project: my-app
      schedule:
        type: cron
        cron: "0 18 * * 1-5"
      action:
        type: agent
        agent: reviewer
        prompt: "Review today's changes. Report bugs and security issues."
```

**Action types**: `shell`, `agent`, `health`, `git_pull`

## Memory System

RemoteClaw maintains a multi-tier memory system:

| Tier | Scope | Storage | Description |
|------|-------|---------|-------------|
| L0 | Session | Claude SDK | Current conversation context |
| L1 | Project | SQLite | Task summaries, known issues, patterns, decisions |
| L2 | Cross-project | SQLite | API contracts between dependent services |

Memory is automatically injected into the agent's context before each task execution.

## Architecture

```
src/
├── cli.ts              # Entry point
├── config/             # YAML config loader + Zod validation
├── channel/telegram/   # Telegram bot (grammY)
├── orchestrator/       # Message routing + command handlers
├── pipeline/           # 6-stage pipeline with hooks
├── agent/              # Claude Code SDK runner + agent profiles
├── preview/            # Tunnel manager (ngrok / cloudflared)
├── memory/             # Multi-tier memory manager
├── cron/               # Job scheduler (interval / cron)
├── skills/             # SKILL.md parser + registry
└── state/              # SQLite persistence (better-sqlite3)
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20+ |
| Language | TypeScript 5 |
| AI Agent | @anthropic-ai/claude-code SDK |
| Telegram | grammY |
| Database | better-sqlite3 (SQLite) |
| Config | YAML + Zod validation |
| Tunneling | ngrok / cloudflared |
| Process | execa |
| Logging | pino |
| Build | tsup |

## License

MIT
