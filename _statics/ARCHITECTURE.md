# RemoteClaw — Architecture Document

> Inspired by [OpenClaw](https://github.com/openclaw/openclaw) (skills, file-based config)
> and [GoClaw](https://github.com/nextlevelbuilder/goclaw) (pipeline, memory tiers).
>
> **Core idea**: Chat → Code → Build → Preview → Verify — from your phone.

---

## 1. Problem Statement

Developers using Claude Code face three pain points:

1. **Multi-project chaos** — Each project is a separate tab. No orchestration between BE/FE/mobile.
2. **Location-bound** — Must sit at the computer. Can't use idle time (commute, breaks).
3. **No verification loop** — After coding, no easy way to verify without manually building and running.

## 2. Solution

RemoteClaw is a self-hostable **TypeScript** app that:

- Bridges **Telegram** (Slack, Discord planned) to **Claude Code SDK** running on your machine
- Runs a **6-stage pipeline** with configurable hooks per project
- Auto **builds, exposes** projects via **ngrok / cloudflared** after code changes
- Sends **preview URLs** back to chat — verify from your phone
- Supports **multi-project** with per-project **agent profiles**, **memory**, and **skills**
- **No API key needed** — uses your existing Claude Code CLI auth
- **No Docker needed** — runs directly on your machine
- **Install**: `npm install -g remoteclaw`

## 3. High-Level Architecture

```
User Phone (Telegram / Slack / Discord)
         │
         ▼
┌──────────────────────────────────────────────────────────────┐
│                   REMOTECLAW (Node.js)                       │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Channel Layer                                        │    │
│  │   Telegram (grammY) · Slack (bolt) · Discord         │    │
│  │   → Gateway interface — pluggable                    │    │
│  └────────────────────────┬─────────────────────────────┘    │
│                           │                                  │
│  ┌────────────────────────▼─────────────────────────────┐    │
│  │ Orchestrator                                         │    │
│  │   Route: command → handler | skill → pipeline |      │    │
│  │          free text → pipeline                        │    │
│  │   Resolve: user, project, agent profile              │    │
│  │   Budget check, rate limiting                        │    │
│  └──────┬──────────────┬────────────────┬───────────────┘    │
│         │              │                │                    │
│  ┌──────▼──────┐ ┌─────▼──────┐ ┌───────▼──────────────┐    │
│  │  Pipeline   │ │  Skills    │ │  Cron Scheduler      │    │
│  │  (6 stages) │ │  Registry  │ │                      │    │
│  │             │ │            │ │  interval / cron     │    │
│  │ Context     │ │ SKILL.md   │ │  shell / agent /     │    │
│  │ Execute     │ │ per skill  │ │  health / git_pull   │    │
│  │ Commit      │ │            │ └──────────────────────┘    │
│  │ Deploy      │ │ /deploy    │                              │
│  │ Record      │ │ /review    │                              │
│  │ Notify      │ │ /test      │                              │
│  └──────┬──────┘ │ /fix       │                              │
│         │        │ /explain   │                              │
│         │        │ /refactor  │                              │
│  ┌──────▼──────┐ │ /custom... │                              │
│  │ Agent       │◄┘            │                              │
│  │ Runner      │              │                              │
│  │             │              │                              │
│  │ Claude Code │ ← query() SDK, AsyncGenerator<SDKMessage>  │
│  │ SDK         │ ← No API key — uses CLI auth               │
│  │             │ ← Agent profiles (model, prompt, tools)     │
│  └──────┬──────┘                                             │
│         │                                                    │
│  ┌──────▼────────────────────────────────────────────────┐   │
│  │ Support Services                                      │   │
│  │                                                       │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │   │
│  │  │ Preview  │  │  Memory  │  │  State Store      │    │   │
│  │  │ Manager  │  │  Manager │  │  (SQLite)         │    │   │
│  │  │          │  │          │  │                    │    │   │
│  │  │ ngrok /  │  │ L0: sess │  │ users             │    │   │
│  │  │ cfd      │  │ L1: proj │  │ tasks             │    │   │
│  │  │          │  │ L2: cross│  │ conversations     │    │   │
│  │  │ build →  │  │          │  │ memory_entries    │    │   │
│  │  │ health → │  │ All in   │  │ cross_project_mem │    │   │
│  │  │ tunnel   │  │ SQLite   │  │ audit_log         │    │   │
│  │  └──────────┘  └──────────┘  └──────────────────┘    │   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  Runs on YOUR machine. Uses YOUR Claude Code auth.           │
│  No Docker. No API key. No server.                           │
└──────────────────────────────────────────────────────────────┘
```

## 4. Tech Stack

| Category | Package | Why |
|----------|---------|-----|
| **Runtime** | Node.js 20+ | Claude Code requires it — already installed |
| **Language** | TypeScript 5 | Type safety, Zod validation |
| **AI Agent** | `@anthropic-ai/claude-code` SDK | Native integration, no subprocess, no API key |
| **Telegram** | grammY | Best TypeScript support for Telegram bots |
| **Database** | better-sqlite3 | Fast, zero-config, single file |
| **Config** | yaml + zod | YAML with env var expansion + runtime validation |
| **Tunnel** | ngrok / cloudflared (binary) | Pluggable via Tunneler interface |
| **Process** | execa | Dev server subprocess management |
| **Logging** | pino + pino-pretty | Fast structured logging |
| **Build** | tsup | Bundle to single JS file |
| **Install** | `npm install -g remoteclaw` | One command |

## 5. Project Structure

```
remoteclaw/
├── src/
│   ├── cli.ts                          # Entry point — wire all components
│   │
│   ├── config/
│   │   ├── schema.ts                   # Zod schemas — full config validation
│   │   └── index.ts                    # loadConfig(), per-project helpers
│   │
│   ├── agent/
│   │   └── index.ts                    # Claude Code SDK query()
│   │                                   #   AgentRegistry — profile management
│   │                                   #   AgentRunner — execute with streaming
│   │
│   ├── pipeline/
│   │   └── index.ts                    # Pipeline runner + 6 stages
│   │                                   #   ContextStage — inject memory + skills
│   │                                   #   ExecuteStage — run Claude via SDK
│   │                                   #   CommitStage — git add + commit + hooks
│   │                                   #   DeployStage — build + tunnel
│   │                                   #   RecordStage — save to SQLite + memory
│   │                                   #   NotifyStage — send result to user
│   │
│   ├── preview/
│   │   └── index.ts                    # Tunneler interface
│   │                                   #   NgrokTunneler
│   │                                   #   CloudflaredTunneler
│   │                                   #   PreviewManager — build → health → tunnel
│   │
│   ├── memory/
│   │   └── index.ts                    # MemoryManager — reads/writes SQLite
│   │                                   #   L1: project memory (task summaries, notes)
│   │                                   #   L2: cross-project (API contracts)
│   │
│   ├── skills/
│   │   └── index.ts                    # SkillRegistry — load + parse SKILL.md
│   │                                   #   Priority: project > user > built-in
│   │
│   ├── cron/
│   │   └── index.ts                    # CronScheduler — interval / cron expression
│   │                                   #   Actions: shell, agent, health, git_pull
│   │
│   ├── channel/
│   │   ├── types.ts                    # Gateway interface, InboundMessage
│   │   └── telegram/index.ts           # grammY bot, auth middleware, commands
│   │
│   ├── orchestrator/
│   │   └── index.ts                    # Route messages → commands | skills | pipeline
│   │
│   └── state/
│       └── index.ts                    # SQLite store — all tables + CRUD
│
├── skills/                             # Built-in skills (SKILL.md files)
│   ├── deploy/SKILL.md
│   ├── review/SKILL.md
│   ├── test/SKILL.md
│   ├── fix/SKILL.md
│   ├── explain/SKILL.md
│   └── refactor/SKILL.md
│
├── config/
│   └── remoteclaw.example.yaml         # Full config example
│
├── _statics/
│   ├── ARCHITECTURE.md                 # This file
│   ├── DESIGN.md                       # System design overview
│   └── FEATURES.md                     # Extended features design
│
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── .env.example
└── .gitignore
```

## 6. Core Components

### 6.1 Agent Runner — Claude Code SDK

**No subprocess. No API key. Native SDK call.**

```typescript
import { query } from "@anthropic-ai/claude-code";

const stream = query({
  prompt: enrichedPrompt,
  options: {
    model: "claude-sonnet-4-20250514",
    maxTurns: 50,
    cwd: "/path/to/project",
    customSystemPrompt: "You are a Java expert...",
    resume: sessionId,           // continue previous conversation
    allowedTools: ["Read", "Edit", "Bash"],
  },
});

// AsyncGenerator — stream events
for await (const msg of stream) {
  switch (msg.type) {
    case "assistant":   // AI text/tool_use response
    case "result":      // final: .result, .total_cost_usd, .subtype
    case "system":      // init, compact_boundary
  }
}
```

**Agent Profiles** — configurable per project:

```yaml
agents:
  java-senior:
    model: claude-opus-4-20250514
    system_prompt: "You are a senior Java developer..."
    max_budget_usd: 10
    max_turns: 80
    allowed_tools: [Read, Edit, Write, Bash, Glob, Grep]

  reviewer:
    model: claude-sonnet-4-20250514
    system_prompt: "You are a code reviewer. Never edit files."
    max_budget_usd: 2
    allowed_tools: [Read, Glob, Grep]    # read-only

projects:
  my-api:
    agent: java-senior      # main coding agent
    reviewer: reviewer       # for /review skill
```

### 6.2 Pipeline — 6 Stages with Hooks

```
Message arrives
    │
    ▼
┌─ Pipeline ──────────────────────────────────────────────┐
│                                                         │
│  1. CONTEXT                                             │
│     ├── Read CLAUDE.md from project dir                 │
│     ├── Query L1 memory from SQLite (recent tasks)      │
│     ├── Query L2 memory (cross-project API contracts)   │
│     ├── Inject skill instructions (if /skill triggered) │
│     └── Build enriched prompt                           │
│                                                         │
│  2. EXECUTE                                             │
│     ├── hooks.before_execute (if configured)            │
│     ├── query() via Claude Code SDK                     │
│     ├── Stream progress → Telegram (throttled 3s)       │
│     ├── Collect result + cost                           │
│     └── hooks.after_execute                             │
│                                                         │
│  3. COMMIT                                              │
│     ├── git diff → detect changed files                 │
│     ├── hooks.before_commit (e.g. "go fmt ./...")       │
│     ├── git add -A && git commit                        │
│     └── hooks.after_commit (e.g. "mvn test")            │
│                                                         │
│  4. DEPLOY                                              │
│     ├── hooks.before_deploy                             │
│     ├── sh -c project.build                             │
│     ├── sh -c project.dev (background)                  │
│     ├── Health check: poll localhost:PORT                │
│     ├── Tunnel: ngrok / cloudflared → public URL        │
│     └── hooks.after_deploy                              │
│                                                         │
│  5. RECORD                                              │
│     ├── Update task in SQLite (status, cost, files)     │
│     ├── Write L1 memory entry (task_summary)            │
│     └── Audit log                                       │
│                                                         │
│  6. NOTIFY                                              │
│     └── Send to Telegram:                               │
│          "Done! [my-api]                                │
│           Files: 3 changed                              │
│           Commit: abc1234                               │
│           Cost: $0.42                                   │
│           Preview: https://abc.ngrok-free.app"          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Hooks** — configurable per project:

```yaml
# Global hooks
pipeline:
  hooks:
    after_commit: "npm test"

# Per-project override
projects:
  my-api:
    hooks:
      before_commit: "mvn checkstyle:check"
      after_commit: "mvn test -q"
```

### 6.3 Memory System — SQLite-backed, 3 Levels

```
┌────────────────────────────────────────────────────────────┐
│                    Memory System                           │
│                                                            │
│  L0: Working Memory                                        │
│  ├── Claude Code session (--resume sessionId)              │
│  ├── Managed by: Claude SDK internally                     │
│  └── Storage: Claude's ~/.claude/ directory                │
│                                                            │
│  L1: Project Memory (SQLite: memory_entries)               │
│  ├── task_summary — "Added /products API (3 files, $0.42)" │
│  ├── known_issue  — "MySQL pool leaks on shutdown"         │
│  ├── pattern      — "Use constructor injection"            │
│  ├── decision     — "Chose UUID over auto-increment"       │
│  ├── note         — Manual notes via /memory add           │
│  ├── Auto-written: RecordStage after each task             │
│  ├── Auto-read: ContextStage injects into prompt           │
│  └── Pruned: keeps last 30 entries per type                │
│                                                            │
│  L2: Cross-Project Memory (SQLite: cross_project_memory)   │
│  ├── api_contract — API endpoints between services         │
│  ├── Grouped by: project_group (e.g. "ecommerce")         │
│  ├── Auto-read: ContextStage for depends_on projects       │
│  └── Replaces on update (latest contract wins)             │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**SQLite tables:**

```sql
memory_entries (
  id, project_slug, type, content, source_task_id, created_at
)
-- type: task_summary | known_issue | pattern | decision | note

cross_project_memory (
  id, project_group, source_project, type, content, created_at
)
-- type: api_contract
```

**Telegram commands:**

```
/memory              — View project memory
/memory clear        — Clear all memory for project
/memory add <note>   — Add manual note
```

### 6.4 Skills System — SKILL.md files (OpenClaw pattern)

Skills are **markdown files with YAML frontmatter**. Agents read skill instructions as context.

```
skills/review/SKILL.md:

---
name: review
description: Code review — analyze for bugs, security, quality
trigger: /review
agent: reviewer           # use read-only agent profile
skip_preview: true
skip_commit: true
---

# Code Review
Review the codebase and report issues. Do NOT edit files.
## What to check
1. Bugs — logic errors, null refs, race conditions
2. Security — injection, auth bypass, secrets
...
```

**Loading priority** (like OpenClaw):
1. Project skills: `<project>/.remoteclaw/skills/`
2. User skills: `~/.remoteclaw/skills/`
3. Built-in skills: `skills/` (shipped with remoteclaw)

**Built-in skills:**

| Skill | Trigger | Agent | Description |
|-------|---------|-------|-------------|
| Deploy | `/deploy` | default | Build + tunnel → preview URL |
| Review | `/review` | reviewer | Read-only code review |
| Test | `/test` | default | Run tests, report results |
| Fix | `/fix` | default | Fix a bug from description |
| Explain | `/explain` | default | Explain code/architecture |
| Refactor | `/refactor` | default | Guided refactoring |

**Execution flow:**

```
User: /review check security
  → SkillRegistry.resolve("review")
  → Pipeline.run({
      prompt: "check security",
      skill: review,              // skill.instructions injected by ContextStage
      agentProfile: "reviewer",   // from SKILL.md
      skipPreview: true,          // from SKILL.md
      skipCommit: true,           // from SKILL.md
    })
```

### 6.5 Preview System — ngrok + cloudflared

**Tunneler interface** — pluggable:

```typescript
interface Tunneler {
  name: string;
  start(port: number): Promise<Tunnel>;
  stop(id: string): void;
}
```

| Feature | ngrok | cloudflared |
|---------|-------|-------------|
| Account required | Yes (free tier) | No |
| Stable URLs | Yes (paid) | No (random) |
| SSE/WebSocket | Yes | Limited |
| Config needed | `auth_token` | None |

**Deploy flow:**

```
Agent completes → DeployStage:
  1. sh -c "mvn package"       (project.build)
  2. sh -c "mvn spring-boot:run" &  (project.dev, background)
  3. Poll http://localhost:8080 every 2s (health check, max 60s)
  4. ngrok http 8080            (or cloudflared)
  5. Parse public URL → send to user
```

### 6.6 Cron Scheduler

```yaml
cron:
  jobs:
    auto-test:
      project: my-api
      schedule: { type: interval, interval: 30m }
      action: { type: shell, command: "mvn test -q" }

    health:
      project: my-api
      schedule: { type: interval, interval: 5m }
      action: { type: health }

    morning-pull:
      project: my-api
      schedule: { type: cron, cron: "0 9 * * 1-5" }
      action: { type: git_pull }

    nightly-review:
      project: my-api
      schedule: { type: cron, cron: "0 22 * * *" }
      action: { type: agent, agent: reviewer, prompt: "Review today's changes" }
```

**Action types:** `shell` | `agent` | `health` | `git_pull`

### 6.7 Channel Gateway — Interface-based

```typescript
interface Gateway {
  onMessage(handler: (msg: InboundMessage) => void): void;
  send(chatId: number, text: string): Promise<void>;
  start(): void;
  stop(): void;
}
```

Current: `TelegramGateway` (grammY). Planned: Slack, Discord.

**Auth:** Telegram user ID allowlist in config.

**Commands:**

| Command | Description |
|---------|-------------|
| `/projects` | List all projects |
| `/switch <name>` | Switch active project |
| `/preview` | Get current preview URL |
| `/status` | Show project status |
| `/agents` | List agent profiles |
| `/skills` | List available skills |
| `/memory` | View/manage project memory |
| `/cron` | Show cron jobs |
| `/cost` | Today's API spend |
| `/deploy` `/review` `/test` `/fix` `/explain` `/refactor` | Skills |

### 6.8 State Store — SQLite

All state in one SQLite file (`data/remoteclaw.db`). Pure JS driver (`better-sqlite3`), no native compilation issues.

```sql
users              (id, telegram_id, display_name, is_admin)
tasks              (id, user_id, project_slug, prompt, status, result_summary,
                    files_changed, preview_url, claude_session_id, cost_usd, ...)
conversations      (id, user_id, project_slug, platform_chat_id,
                    platform_thread_id, claude_session_id, is_active)
memory_entries     (id, project_slug, type, content, source_task_id)
cross_project_memory (id, project_group, source_project, type, content)
audit_log          (id, user_id, action, details)
```

## 7. Configuration

Full YAML config with env var expansion (`${VAR}`), Zod validation, per-project overrides.

```yaml
channels:
  telegram:
    bot_token: ${TELEGRAM_BOT_TOKEN}
    mode: polling

auth:
  allowed_telegram_ids: [123456789]
  admin_telegram_ids: [123456789]

agents:
  default:
    model: claude-sonnet-4-20250514
    max_budget_usd: 5
    max_turns: 50
  java-senior:
    model: claude-opus-4-20250514
    system_prompt: "You are a senior Java developer..."
    max_budget_usd: 10
  reviewer:
    model: claude-sonnet-4-20250514
    system_prompt: "Code reviewer. Never edit files."
    allowed_tools: [Read, Glob, Grep]

projects:
  my-api:
    path: /Users/me/projects/my-api
    language: java
    port: 8080
    build: mvn package -DskipTests
    dev: mvn spring-boot:run
    agent: java-senior
    reviewer: reviewer
    group: ecommerce
    hooks:
      before_commit: "mvn checkstyle:check"
      after_commit: "mvn test -q"

  my-frontend:
    path: /Users/me/projects/my-frontend
    language: node
    port: 3000
    dev: npm run dev
    agent: default
    group: ecommerce
    depends_on: [my-api]

preview:
  provider: cloudflared     # ngrok | cloudflared
  auto_preview: true

pipeline:
  skip_preview: false
  skip_commit: false

cron:
  jobs:
    auto-test:
      project: my-api
      schedule: { type: interval, interval: 30m }
      action: { type: shell, command: "mvn test -q" }

database:
  path: data/remoteclaw.db
```

## 8. Message Flow

```
📱 User sends "Add /products API" via Telegram
    │
    ▼
TelegramGateway
    ├── Auth middleware: check telegram_id in allowlist
    ├── Normalize to InboundMessage
    └── Call handler
         │
         ▼
    Orchestrator.handleMessage()
    ├── ensureUser() — create in SQLite if new
    ├── Is command? → handleCommand()
    ├── Is /skill? → handleSkill()
    └── Free text → handleTask()
              │
              ▼
         Resolve:
         ├── Project: from /switch or auto (if only 1)
         ├── Agent profile: from project config
         ├── Pipeline config: global + per-project merge
         ├── Hooks: global + per-project merge
         └── Create task record (status: running)
              │
              ▼
         Pipeline.run(state)
         ├── 1. Context → inject CLAUDE.md + memory + skill
         ├── 2. Execute → query() SDK → stream progress
         ├── 3. Commit → git diff → hooks → git commit
         ├── 4. Deploy → build → dev server → tunnel
         ├── 5. Record → SQLite task + memory entry
         └── 6. Notify → send result + URL to Telegram
              │
              ▼
📱 User receives:
    "Done! [my-api]
     Added ProductController, ProductService
     Files: 3 changed
     Commit: abc1234
     Cost: $0.42
     Preview: https://abc123.ngrok-free.app"
```

## 9. Multi-Project Coordination

```yaml
projects:
  ecommerce-api:     # Java backend
    group: ecommerce
    port: 8080
  ecommerce-web:     # PHP frontend
    group: ecommerce
    depends_on: [ecommerce-api]
```

When working on `ecommerce-web`, ContextStage queries `cross_project_memory` for group `ecommerce`, injects API contracts from `ecommerce-api` into the prompt:

```
## Related Projects
### ecommerce-api (java, port 8080)
GET /api/products → [{id, name, price}]
POST /api/orders → {userId, items[]}
```

## 10. Security

| Threat | Mitigation |
|--------|-----------|
| Unauthorized bot access | Telegram user ID allowlist |
| API cost overrun | Budget per task + daily limit |
| Malicious skill | Skills are instructions, not executable code |
| Secrets in config | `${ENV_VAR}` expansion, .env in .gitignore |
| Preview exposure | Tunnel URLs are random, auto-close on shutdown |

## 11. Installation & Usage

```bash
# Install
npm install -g remoteclaw

# Setup
cp config/remoteclaw.example.yaml config/remoteclaw.yaml
# Edit: telegram bot token, project paths, auth IDs

# Set env vars
export TELEGRAM_BOT_TOKEN=your-token

# Run
remoteclaw config/remoteclaw.yaml

# Or development mode
npm run dev -- config/remoteclaw.yaml
```

## 12. Roadmap

### Phase 1: Core ✅
- [x] Config (Zod + YAML)
- [x] State store (SQLite — users, tasks, conversations, memory)
- [x] Agent runner (Claude Code SDK, profiles, registry)
- [x] Pipeline (6 stages + hooks)
- [x] Preview (ngrok + cloudflared)
- [x] Telegram gateway (grammY)
- [x] Orchestrator

### Phase 2: Memory + Skills ✅
- [x] Memory L1 — project memory in SQLite
- [x] Memory L2 — cross-project memory in SQLite
- [x] Skills registry + SKILL.md parser
- [x] Built-in skills: deploy, review, test, fix, explain, refactor
- [x] Cron scheduler (interval + cron)
- [x] ContextStage: inject memory + skills

### Phase 3: Production (planned)
- [ ] Slack gateway (bolt.js)
- [ ] Discord gateway
- [ ] Multi-agent delegation (sequential cross-project)
- [ ] Updater (self-update from GitHub)
- [ ] Web dashboard
- [ ] `npm publish` → `npm install -g remoteclaw`

## 13. Design Decisions

| # | Decision | Choice | Trade-off |
|---|----------|--------|-----------|
| 1 | Language | **TypeScript** | Claude Code SDK is native TS, npm already installed |
| 2 | Agent execution | **Claude Code SDK** `query()` | Native, no subprocess, no API key needed |
| 3 | Database | **SQLite** (better-sqlite3) | No scaling, but zero ops + single file |
| 4 | Memory storage | **SQLite tables** | More structured than files, queryable, prunable |
| 5 | Skills format | **SKILL.md** (OpenClaw pattern) | Plain files, agent reads as context |
| 6 | Tunnel | **Pluggable** (ngrok + cloudflared) | Two implementations, but user choice |
| 7 | Pipeline | **6 stages + hooks** | More complex, but configurable per project |
| 8 | Config | **YAML + Zod** | Env var expansion + runtime validation |
| 9 | Install | **`npm install -g`** | Requires Node.js, but already installed |
| 10 | Architecture | **Monolith** | Can't scale, but simple + shared SQLite |
