# RemoteClaw — System Design Overview

> Tham khảo: [OpenClaw](https://github.com/openclaw/openclaw) (skill system, file-based config, multi-channel),
> [GoClaw](https://github.com/nextlevelbuilder/goclaw) (pipeline, event bus, memory tiers).
> RemoteClaw focus: **Developer workflow** — Chat → Code → Build → Preview → Verify.

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         REMOTECLAW                              │
│                    (Node.js, single process)                    │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    Channel Layer                          │  │
│  │  Telegram (grammY)  ·  Slack (bolt)  ·  Discord  ·  Web  │  │
│  └────────────────────────────┬──────────────────────────────┘  │
│                               │                                 │
│  ┌────────────────────────────▼──────────────────────────────┐  │
│  │                    Router / Orchestrator                  │  │
│  │  - Resolve user, project, session                        │  │
│  │  - Route to command handler or pipeline                  │  │
│  │  - Rate limiting, budget check                           │  │
│  └──────┬────────────────┬───────────────────┬──────────────┘  │
│         │                │                   │                  │
│  ┌──────▼──────┐  ┌──────▼──────┐  ┌─────────▼────────────┐   │
│  │  Pipeline   │  │   Skills    │  │   Cron Scheduler     │   │
│  │  (6 stages) │  │  Registry   │  │   (interval/cron)    │   │
│  │             │  │             │  │                      │   │
│  │ Context     │  │ SKILL.md    │  │ auto-test, health,   │   │
│  │ Execute     │  │ per skill   │  │ git-pull, review     │   │
│  │ Commit      │  │             │  │                      │   │
│  │ Deploy      │  │ /deploy     │  └──────────────────────┘   │
│  │ Record      │  │ /review     │                              │
│  │ Notify      │  │ /test       │                              │
│  └──────┬──────┘  │ /refactor   │                              │
│         │         │ /explain    │                              │
│         │         │ /custom...  │                              │
│  ┌──────▼──────┐  └──────┬──────┘                              │
│  │ Agent Runner│◄────────┘                                     │
│  │             │                                               │
│  │ Claude Code │  ← query() SDK, NO API key, uses CLI auth    │
│  │ SDK         │  ← AsyncGenerator<SDKMessage>                │
│  │             │  ← Agent profiles (model, prompt, tools)     │
│  └──────┬──────┘                                               │
│         │                                                      │
│  ┌──────▼──────────────────────────────────────────────────┐   │
│  │                   Support Services                      │   │
│  │                                                         │   │
│  │  ┌──────────┐  ┌──────────┐  ┌────────┐  ┌──────────┐  │   │
│  │  │ Preview  │  │  Memory  │  │ State  │  │ Updater  │  │   │
│  │  │ Manager  │  │  System  │  │ Store  │  │          │  │   │
│  │  │          │  │          │  │        │  │ self +   │  │   │
│  │  │ ngrok /  │  │ L0 sess  │  │ SQLite │  │ project  │  │   │
│  │  │ cfd      │  │ L1 proj  │  │        │  │ git pull │  │   │
│  │  │          │  │ L2 cross │  │        │  │          │  │   │
│  │  └──────────┘  └──────────┘  └────────┘  └──────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Runs on your machine. Uses your Claude Code auth.             │
│  No Docker needed. No API key needed.                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Execution Flow

```
📱 User sends "Add /products API" via Telegram
         │
         ▼
    ┌─ Router ─────────────────────────────────────────────────┐
    │  1. Auth: check telegram_id allowlist                    │
    │  2. Resolve project: from /switch or Telegram Topic      │
    │  3. Resolve agent: project config → agent profile        │
    │  4. Budget check: daily cost < limit?                    │
    │  5. Is it a /command? → command handler                  │
    │     Is it a /skill? → skill handler                      │
    │     Free text? → pipeline                                │
    └─────────────────────┬────────────────────────────────────┘
                          │
    ┌─ Pipeline ──────────▼────────────────────────────────────┐
    │                                                          │
    │  Stage 1: CONTEXT                                        │
    │  ├── Read CLAUDE.md from project                         │
    │  ├── Load L1 memory (recent task summaries)              │
    │  ├── Load L2 memory (cross-project API contracts)        │
    │  ├── Load active skill instructions (if any)             │
    │  └── Build enriched prompt                               │
    │                                                          │
    │  Stage 2: EXECUTE                                        │
    │  ├── Run hooks.before_execute (if configured)            │
    │  ├── query({ prompt, options })  ← Claude Code SDK       │
    │  │     model: from agent profile                         │
    │  │     systemPrompt: from agent profile + context        │
    │  │     cwd: project.path                                 │
    │  │     resume: sessionId (if continuing)                 │
    │  ├── for await (msg of stream) → progress to Telegram    │
    │  └── Run hooks.after_execute                             │
    │                                                          │
    │  Stage 3: COMMIT                                         │
    │  ├── git diff → detect changed files                     │
    │  ├── Run hooks.before_commit (e.g. "go fmt ./...")       │
    │  ├── git add -A && git commit                            │
    │  └── Run hooks.after_commit (e.g. "mvn test")            │
    │                                                          │
    │  Stage 4: DEPLOY                                         │
    │  ├── Run hooks.before_deploy                             │
    │  ├── Build: sh -c project.build                          │
    │  ├── Dev server: sh -c project.dev                       │
    │  ├── Health check: poll localhost:PORT                    │
    │  ├── Tunnel: ngrok/cloudflared → public URL              │
    │  └── Run hooks.after_deploy                              │
    │                                                          │
    │  Stage 5: RECORD                                         │
    │  ├── Save task to SQLite                                 │
    │  ├── Update memory (L1 task summary)                     │
    │  └── Audit log                                           │
    │                                                          │
    │  Stage 6: NOTIFY                                         │
    │  └── Send to Telegram:                                   │
    │       "Done! [ecommerce-api]                             │
    │        Files: 3 changed                                  │
    │        Commit: abc1234                                   │
    │        Cost: $0.42                                       │
    │        Preview: https://abc.ngrok-free.app"              │
    │                                                          │
    └──────────────────────────────────────────────────────────┘
```

---

## 3. Memory System

Inspired by GoClaw's 3-tier + OpenClaw's file-based approach.

```
┌─────────────────────────────────────────────────────────────┐
│                     Memory System                           │
│                                                             │
│  L0: Working Memory                                         │
│  ├── What: Current conversation in Claude session           │
│  ├── Managed by: Claude Code SDK (--resume sessionId)       │
│  ├── Storage: Claude internal (~/.claude/)                  │
│  └── Lifetime: per session, auto-compacted by Claude        │
│                                                             │
│  L1: Project Memory                                         │
│  ├── What: Task summaries, known issues, decisions          │
│  ├── Managed by: MemoryManager (auto after each task)       │
│  ├── Storage: .remoteclaw/memory.md in project dir          │
│  ├── Format: plain markdown (agent reads in context stage)  │
│  ├── Injected: Pipeline ContextStage reads this file        │
│  └── Lifetime: persistent, pruned when > 50 entries         │
│                                                             │
│  L2: Cross-Project Memory                                   │
│  ├── What: API contracts, shared types between services     │
│  ├── Managed by: MemoryManager (on cross-project events)    │
│  ├── Storage: .remoteclaw/cross/<group>.md per project      │
│  ├── Injected: ContextStage reads for depends_on projects   │
│  └── Lifetime: persistent, updated on API changes           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### L1 Memory File Format

```markdown
<!-- .remoteclaw/memory.md — auto-managed by RemoteClaw -->

## Recent Tasks
- [2025-04-15] Added GET /products endpoint (cost: $0.42, 3 files)
- [2025-04-14] Fixed MySQL connection pool leak (cost: $0.31, 1 file)
- [2025-04-13] Added pagination to /users endpoint (cost: $0.55, 2 files)

## Known Issues
- MySQL pool needs manual close on shutdown
- Rate limiter not applied to /admin routes

## Decisions
- Using constructor injection, not @Autowired
- UUID for all entity IDs, not auto-increment

## Patterns
- All controllers extend BaseController
- Use @Transactional for write operations
```

### L2 Cross-Project File Format

```markdown
<!-- .remoteclaw/cross/ecommerce.md — auto-managed -->

## ecommerce-api (Java, port 8080)
Last updated: 2025-04-15

### API Endpoints
- GET /api/products → [{id, name, price, category}]
- GET /api/products/:id → {id, name, price, category, description}
- POST /api/products → {name, price, category} → {id, ...}
- GET /api/users → [{id, name, email}]
- POST /api/orders → {userId, items[{productId, qty}]} → {orderId}

### Shared Types
```json
Product: {id: string, name: string, price: number, category: string}
User: {id: string, name: string, email: string}
```
```

### Implementation

```typescript
// src/memory/index.ts
export class MemoryManager {
  // Called after each task completion
  async recordTask(projectPath: string, summary: TaskSummary): Promise<void>
  
  // Called when cross-project changes detected
  async updateCrossProjectMemory(group: string, project: string, apiInfo: string): Promise<void>
  
  // Read for context injection
  getProjectMemory(projectPath: string): string | null
  getCrossProjectMemory(projectPath: string, dependsOn: string[]): string | null
  
  // Manual operations
  addNote(projectPath: string, note: string): void
  clearMemory(projectPath: string): void
}
```

---

## 4. Skills System

Inspired by OpenClaw's SKILL.md approach — skills are **plain markdown files**, not code plugins.

```
┌─────────────────────────────────────────────────────────────┐
│                     Skills System                           │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Skill Registry                                     │    │
│  │                                                     │    │
│  │  Built-in:                                          │    │
│  │  ├── /deploy  — build + expose preview              │    │
│  │  ├── /review  — code review (uses reviewer agent)   │    │
│  │  ├── /test    — run tests, report results           │    │
│  │  ├── /explain — explain code/architecture           │    │
│  │  ├── /refactor — refactor with guidance             │    │
│  │  ├── /fix     — fix a bug from description          │    │
│  │  ├── /pr      — create PR with summary              │    │
│  │  └── /status  — project health dashboard            │    │
│  │                                                     │    │
│  │  Custom (user-defined):                             │    │
│  │  ├── skills/deploy-k8s/SKILL.md                     │    │
│  │  ├── skills/db-migrate/SKILL.md                     │    │
│  │  └── skills/my-custom/SKILL.md                      │    │
│  │                                                     │    │
│  │  Project-specific:                                  │    │
│  │  └── <project>/.remoteclaw/skills/SKILL.md          │    │
│  │                                                     │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  Skill Loading Priority (like OpenClaw):                    │
│  1. Project skills (.remoteclaw/skills/)                    │
│  2. User skills (~/.remoteclaw/skills/)                     │
│  3. Built-in skills (bundled with remoteclaw)               │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### SKILL.md Format (from OpenClaw pattern)

```markdown
---
name: deploy
description: Build project and expose via tunnel for preview
trigger: /deploy
agent: default
args:
  - name: port
    description: Override default port
    required: false
---

# Deploy Skill

## Instructions

1. Run the project's build command
2. Start the dev server
3. Wait for health check to pass
4. Create a tunnel (ngrok or cloudflared)
5. Report the preview URL

## When to use

Use this skill when:
- User wants to preview their changes
- After code changes that need visual verification
- When user says "deploy", "preview", "expose", "show me"
```

### Skill Execution Flow

```
User: /review
    │
    ▼
SkillRegistry.resolve("review")
    │
    ├── Load SKILL.md → parse frontmatter + instructions
    ├── Resolve agent: skill.agent or project.reviewer
    │
    ▼
Pipeline.run({
  prompt: skill.instructions + user's context,
  agentProfile: skill.agent ?? project.reviewer ?? "default",
  skipPreview: true,   // review doesn't need deploy
  skipCommit: true,    // review doesn't change code
})
    │
    ▼
Agent executes with skill instructions as system prompt
    │
    ▼
Result sent to user via Telegram
```

### Implementation

```typescript
// src/skills/index.ts
export interface Skill {
  name: string;
  description: string;
  trigger: string;        // /deploy, /review, etc.
  agent?: string;         // agent profile override
  instructions: string;   // full markdown instructions
  args?: SkillArg[];
  pipelineOverrides?: {
    skipPreview?: boolean;
    skipCommit?: boolean;
  };
}

export class SkillRegistry {
  private skills = new Map<string, Skill>();

  // Load from multiple sources with priority
  loadBuiltIn(): void
  loadUserSkills(dir: string): void
  loadProjectSkills(projectPath: string): void
  
  resolve(trigger: string): Skill | undefined
  list(): Skill[]
  
  // Parse SKILL.md file
  private parseSkillFile(path: string): Skill
}
```

### Built-in Skills (shipped with RemoteClaw)

| Skill | Trigger | Agent | Pipeline Overrides | Description |
|-------|---------|-------|--------------------|-------------|
| Deploy | `/deploy` | default | skipCommit: true | Build + tunnel + preview URL |
| Review | `/review` | reviewer | skip both | Read-only code review |
| Test | `/test` | default | skip both | Run tests, report results |
| Fix | `/fix <desc>` | default | normal | Fix a described bug |
| Explain | `/explain <file>` | default | skip both | Explain code/architecture |
| Refactor | `/refactor <what>` | default | normal | Guided refactoring |
| PR | `/pr` | default | skipDeploy | Create PR with summary |
| Status | `/status` | — | — | Show project health (no agent) |

---

## 5. Agent Profiles

```yaml
agents:
  default:
    model: claude-sonnet-4-20250514
    max_budget_usd: 5
    max_turns: 50

  senior:
    model: claude-opus-4-20250514
    system_prompt: "You are a senior developer. Think carefully..."
    max_budget_usd: 10
    max_turns: 80

  reviewer:
    model: claude-sonnet-4-20250514
    system_prompt: "You are a code reviewer. Never edit files."
    max_budget_usd: 2
    max_turns: 20
    allowed_tools: [Read, Glob, Grep]    # read-only

  quick:
    model: claude-haiku-4-5-20251001
    max_budget_usd: 1
    max_turns: 10

projects:
  my-api:
    agent: senior        # main coding agent
    reviewer: reviewer   # for /review skill
```

---

## 6. Cron System

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

---

## 7. File Layout

```
~/.remoteclaw/                          # Global config
├── config.yaml                         # Global settings
└── skills/                             # User-defined skills
    ├── my-custom-skill/SKILL.md
    └── deploy-k8s/SKILL.md

<project>/                              # Per-project
├── .remoteclaw/
│   ├── memory.md                       # L1 project memory
│   ├── cross/                          # L2 cross-project memory
│   │   └── <group>.md
│   └── skills/                         # Project-specific skills
│       └── <skill>/SKILL.md
├── CLAUDE.md                           # Project context (read by Claude)
└── ...project files...

remoteclaw/                             # RemoteClaw source
├── src/
│   ├── cli.ts                          # Entry point
│   ├── config/                         # Zod schemas + YAML loader
│   ├── agent/                          # Claude Code SDK, profiles, registry
│   ├── pipeline/                       # 6 stages + hooks
│   ├── preview/                        # Tunneler interface + ngrok/cfd
│   ├── memory/                         # L1/L2 memory manager   ← NEW
│   ├── skills/                         # Skill registry + loader ← NEW
│   ├── cron/                           # Scheduler               ← NEW
│   ├── channel/                        # Gateway + Telegram/Slack
│   ├── orchestrator/                   # Router + command handlers
│   └── state/                          # SQLite store
├── skills/                             # Built-in skills         ← NEW
│   ├── deploy/SKILL.md
│   ├── review/SKILL.md
│   ├── test/SKILL.md
│   ├── fix/SKILL.md
│   ├── explain/SKILL.md
│   └── refactor/SKILL.md
├── config/
│   └── remoteclaw.example.yaml
└── package.json
```

---

## 8. Implementation Roadmap

### Phase 1: Core (current) ✅
- [x] Config (zod + YAML)
- [x] State (SQLite)
- [x] Agent runner (Claude Code SDK)
- [x] Pipeline (6 stages + hooks)
- [x] Preview (ngrok + cloudflared)
- [x] Telegram gateway (grammY)
- [x] Orchestrator

### Phase 2: Memory + Skills
- [ ] Memory L1 (project memory, auto-record after tasks)
- [ ] Memory L2 (cross-project, API contract extraction)
- [ ] Skills registry (load SKILL.md, built-in skills)
- [ ] Built-in skills: /deploy, /review, /test, /fix, /explain
- [ ] ContextStage: inject memory + skill instructions

### Phase 3: Automation
- [ ] Cron scheduler (interval + cron jobs)
- [ ] Updater (self-update from GitHub releases)
- [ ] Health monitoring for active previews
- [ ] Multi-agent delegation (sequential cross-project tasks)

### Phase 4: Multi-channel + Production
- [ ] Slack gateway (bolt.js)
- [ ] Discord gateway
- [ ] Webhook mode for Telegram
- [ ] Web dashboard (optional)
- [ ] npm publish → `npm install -g remoteclaw`

---

## 9. Key Design Principles

| # | Principle | From | Applied in RemoteClaw |
|---|-----------|------|-----------------------|
| 1 | **File-based everything** | OpenClaw | Skills = SKILL.md, memory = markdown, config = YAML |
| 2 | **Agent self-discovery** | OpenClaw | Agent reads CLAUDE.md + memory + skill instructions from files |
| 3 | **Pipeline with hooks** | GoClaw | 6 stages, configurable before/after hooks per project |
| 4 | **Pluggable interfaces** | Both | Gateway, Tunneler, Stage — all replaceable |
| 5 | **No API key needed** | RemoteClaw | Uses Claude Code CLI auth already on machine |
| 6 | **Profile-based agents** | GoClaw | Different model/prompt/tools per project |
| 7 | **Progressive memory** | GoClaw | L0 always, L1/L2 loaded by ContextStage when relevant |
| 8 | **Preview is the key** | RemoteClaw | Auto build + tunnel after code changes |
