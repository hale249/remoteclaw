# RemoteClaw - Extended Features Design

> Các module mở rộng trên nền MVP: Agent, Memory, Pipeline, Cron, Updater

## 1. Agent System

### Bài toán

MVP hiện tại chỉ có 1 kiểu agent (Claude Code CLI chạy thẳng). Thực tế cần:
- Agent profiles khác nhau cho từng project (Java agent hiểu Spring Boot, PHP agent hiểu Laravel)
- Multi-agent delegation (agent backend gọi agent frontend)
- Custom tools per agent (agent này được chạy deploy, agent kia chỉ được đọc code)

### Thiết kế

```
┌──────────────────────────────────────────────┐
│                Agent Registry                │
│                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ java-dev │  │ php-dev  │  │ go-dev   │   │
│  │          │  │          │  │          │   │
│  │ model:   │  │ model:   │  │ model:   │   │
│  │  opus    │  │  sonnet  │  │  sonnet  │   │
│  │          │  │          │  │          │   │
│  │ system:  │  │ system:  │  │ system:  │   │
│  │ "Spring  │  │ "Laravel │  │ "Go best │   │
│  │  Boot    │  │  expert" │  │  practic │   │
│  │  expert" │  │          │  │  es"     │   │
│  │          │  │          │  │          │   │
│  │ tools:   │  │ tools:   │  │ tools:   │   │
│  │  all     │  │  no-bash │  │  all     │   │
│  │          │  │          │  │          │   │
│  │ budget:  │  │ budget:  │  │ budget:  │   │
│  │  $10     │  │  $5      │  │  $5      │   │
│  └──────────┘  └──────────┘  └──────────┘   │
└──────────────────────────────────────────────┘
```

### Config

```yaml
agents:
  java-dev:
    model: claude-opus-4-20250514
    system_prompt: |
      You are a senior Java/Spring Boot developer.
      Always use constructor injection, not @Autowired.
      Follow the project's existing patterns in CLAUDE.md.
    max_budget_usd: 10.0
    max_turns: 80
    allowed_tools: [Read, Edit, Write, Bash, Glob, Grep]

  php-dev:
    model: claude-sonnet-4-20250514
    system_prompt: |
      You are a Laravel expert.
      Use Eloquent ORM, follow PSR-12.
    max_budget_usd: 5.0
    max_turns: 50
    allowed_tools: [Read, Edit, Write, Glob, Grep]  # no Bash

  code-reviewer:
    model: claude-sonnet-4-20250514
    system_prompt: |
      You are a code reviewer. Read code and report issues.
      Never edit files. Only analyze and suggest.
    max_budget_usd: 2.0
    max_turns: 20
    allowed_tools: [Read, Glob, Grep]  # read-only

  deployer:
    model: claude-haiku-4-5-20251001
    system_prompt: |
      You handle build and deployment tasks.
    max_budget_usd: 1.0
    max_turns: 10
    allowed_tools: [Read, Bash]

# Project -> Agent binding
projects:
  ecommerce-api:
    language: java
    agent: java-dev           # uses java-dev profile
    reviewer: code-reviewer   # for /review command

  ecommerce-web:
    language: php
    agent: php-dev
```

### Implementation

```go
// internal/agent/profile.go
type Profile struct {
    Name         string
    Model        string
    SystemPrompt string
    MaxBudgetUSD float64
    MaxTurns     int
    AllowedTools []string
}

type Registry struct {
    profiles map[string]*Profile
}

func (r *Registry) Get(name string) *Profile
func (r *Registry) GetForProject(projectSlug string) *Profile
```

```go
// internal/agent/runner.go - updated Execute
func (r *Runner) Execute(ctx context.Context, opts ExecOpts) (<-chan Event, error) {
    profile := r.registry.Get(opts.AgentProfile)

    args := []string{
        "-p", opts.Prompt,
        "--output-format", "stream-json",
        "--model", profile.Model,
        "--max-turns", strconv.Itoa(profile.MaxTurns),
    }

    if profile.SystemPrompt != "" {
        args = append(args, "--system-prompt", profile.SystemPrompt)
    }

    // ... rest of execution
}
```

### Multi-Agent Delegation

Khi task cần nhiều project:

```
User: "Review backend code rồi fix bugs tìm được"

Orchestrator:
  1. Dispatch to code-reviewer agent (read-only)
     -> Scan code, find 3 bugs
  2. Extract bug list from reviewer result
  3. Dispatch to java-dev agent
     -> Fix 3 bugs found by reviewer
  4. Return combined result
```

```go
// internal/orchestrator/delegation.go
type DelegationPlan struct {
    Steps []DelegationStep
}

type DelegationStep struct {
    Agent       string   // agent profile name
    Project     string   // project slug
    Prompt      string   // task prompt
    DependsOn   []int    // index of steps this depends on
    InjectFrom  []int    // inject results from these steps into prompt
}

func (o *Orchestrator) executeDelegation(ctx context.Context, plan DelegationPlan) error {
    results := make([]string, len(plan.Steps))

    for i, step := range plan.Steps {
        // Wait for dependencies
        // Inject results from previous steps into prompt
        // Execute agent
        // Store result
    }
    return nil
}
```

### Telegram UX

```
/agent list              — Show all agent profiles
/agent info <name>       — Show agent details
/review                  — Run code-reviewer on active project
/delegate "review then fix bugs"  — Multi-agent delegation
```

---

## 2. Memory System

### Bài toán

Claude Code CLI có `--resume` để tiếp tục session, nhưng:
- Session bị mất khi context quá dài (compaction)
- Không nhớ cross-session (task hôm qua liên quan task hôm nay)
- Không nhớ cross-project (backend thay đổi API, frontend cần biết)

### Thiết kế: 3-Level Memory (inspired by GoClaw)

```
┌────────────────────────────────────────────────────────┐
│                    Memory System                       │
│                                                        │
│  L0: Working Memory (trong Claude session)             │
│  ├── Current conversation                              │
│  ├── Managed by: claude --resume                       │
│  └── Lifetime: per session                             │
│                                                        │
│  L1: Project Memory (SQLite + files)                   │
│  ├── Task history summaries                            │
│  ├── Known issues / patterns                           │
│  ├── API contracts (auto-extracted)                    │
│  ├── Managed by: MemoryWorker (async after each task)  │
│  └── Lifetime: persistent per project                  │
│                                                        │
│  L2: Cross-Project Memory (SQLite)                     │
│  ├── API contracts between services                    │
│  ├── Shared types / interfaces                         │
│  ├── Recent changes in dependent projects              │
│  ├── Managed by: MemoryWorker (on cross-project events)│
│  └── Lifetime: persistent per project group            │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### L1: Project Memory

Sau mỗi task hoàn thành, MemoryWorker tạo summary và lưu:

```go
// internal/memory/memory.go
type ProjectMemory struct {
    ProjectSlug  string
    Entries      []MemoryEntry
}

type MemoryEntry struct {
    ID        string
    Type      MemoryType
    Content   string
    Source    string     // task_id that created this
    CreatedAt time.Time
    ExpiresAt *time.Time // nil = permanent
}

type MemoryType string
const (
    MemoryTaskSummary   MemoryType = "task_summary"    // "Added /products API"
    MemoryKnownIssue    MemoryType = "known_issue"     // "MySQL connection pool leaks"
    MemoryAPIContract   MemoryType = "api_contract"    // "GET /products -> [{id,name,price}]"
    MemoryPattern       MemoryType = "pattern"         // "Use @Transactional for writes"
    MemoryDecision      MemoryType = "decision"        // "Chose Redis over Memcached"
)
```

**Storage**: File-based per project (injected as context):

```
/projects/ecommerce-api/.remoteclaw/
  memory.json          # structured memory entries
  api_contracts.md     # auto-extracted API docs
```

### L2: Cross-Project Memory

```go
// internal/memory/cross_project.go
type CrossProjectMemory struct {
    Group   string            // project group name
    APIs    map[string]string // project -> API summary
    Changes []RecentChange    // recent changes in group
}

type RecentChange struct {
    ProjectSlug string
    TaskID      string
    Summary     string
    Timestamp   time.Time
}
```

### Context Injection Flow

```
User asks: "Fix the products page"
                |
                v
Pipeline Stage 1 (Context):
  1. Load L1 memory for "ecommerce-web":
     - Last 5 task summaries
     - Known issues for this project
  2. Load L2 memory for group "ecommerce":
     - API contracts from ecommerce-api
     - Recent changes: "Added /products endpoint yesterday"
  3. Build enriched prompt:
     "## Project Memory
      Last tasks: ...
      Known issues: ...

      ## Related Projects
      Backend API (ecommerce-api):
        GET /products -> [{id,name,price}]
        Changed yesterday: added price field

      ## Task
      Fix the products page"
```

### MemoryWorker (async)

```go
// internal/eventbus/workers/memory.go
type MemoryWorker struct {
    store  state.Store
    logger *slog.Logger
}

func (w *MemoryWorker) Handle(ctx context.Context, event eventbus.Event) error {
    payload := event.Payload.(eventbus.TaskCompletedPayload)

    // 1. Summarize task result into memory entry
    entry := MemoryEntry{
        Type:    MemoryTaskSummary,
        Content: summarize(payload.Result), // truncate to key info
        Source:  payload.TaskID,
    }

    // 2. Auto-detect API contracts from changed files
    contracts := extractAPIContracts(payload.ProjectPath, payload.FilesChanged)

    // 3. Save to project memory file
    saveProjectMemory(payload.ProjectPath, entry, contracts)

    // 4. Update cross-project memory if in a group
    updateCrossProjectMemory(payload.ProjectSlug, entry, contracts)

    return nil
}
```

### SQLite Schema Addition

```sql
-- internal/state/migrations/002_memory.sql

CREATE TABLE IF NOT EXISTS memory_entries (
    id            TEXT PRIMARY KEY,
    project_slug  TEXT NOT NULL,
    type          TEXT NOT NULL,
    content       TEXT NOT NULL,
    source_task   TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    expires_at    TEXT
);

CREATE TABLE IF NOT EXISTS cross_project_memory (
    id            TEXT PRIMARY KEY,
    project_group TEXT NOT NULL,
    source_project TEXT NOT NULL,
    type          TEXT NOT NULL,
    content       TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_entries(project_slug, type);
CREATE INDEX IF NOT EXISTS idx_cross_memory_group ON cross_project_memory(project_group);
```

### Telegram UX

```
/memory                  — Show memory for active project
/memory clear            — Clear project memory
/memory add "note"       — Manually add a memory entry
/remember "always use UUIDs"  — Add permanent pattern memory
```

---

## 3. Pipeline System

### Bài toán

MVP hiện tại chạy tuần tự: message -> claude -> done. Cần:
- Hook vào từng giai đoạn (before/after)
- Retry logic khi stage fail
- Budget check giữa các stage
- Pluggable stages (thêm stage mới dễ dàng)

### Thiết kế: 7-Stage Pipeline

```
┌─────────────────────────────────────────────────────────┐
│                     Pipeline                            │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │1. Auth   │→ │2. Context│→ │3. Execute│              │
│  │  & Rate  │  │  Memory  │  │  Claude  │              │
│  │  Limit   │  │  Inject  │  │  CLI     │              │
│  └──────────┘  └──────────┘  └────┬─────┘              │
│                                    │                    │
│                              ┌─────v─────┐              │
│                              │4. Stream  │              │
│                              │  Parse &  │              │
│                              │  Progress │              │
│                              └─────┬─────┘              │
│                                    │                    │
│  ┌──────────┐  ┌──────────┐  ┌─────v─────┐              │
│  │7. Notify │← │6. Deploy │← │5. Commit │              │
│  │  User    │  │  Preview │  │  & Record│              │
│  └──────────┘  └──────────┘  └──────────┘              │
│                                                         │
│  Hooks: OnBefore(stage) / OnAfter(stage) / OnError     │
└─────────────────────────────────────────────────────────┘
```

### Implementation

```go
// internal/pipeline/pipeline.go
type Pipeline struct {
    stages []Stage
    hooks  *Hooks
    logger *slog.Logger
}

type Stage interface {
    Name() string
    Execute(ctx context.Context, state *State) error
}

type Hooks struct {
    OnBefore func(stageName string, state *State)
    OnAfter  func(stageName string, state *State)
    OnError  func(stageName string, state *State, err error) error // return nil to continue
}

// State — mutable state passed through all stages
type State struct {
    // Input
    Message   channel.InboundMessage
    User      *state.User
    Project   *config.Project
    Agent     *agent.Profile

    // Built during pipeline
    EnrichedPrompt string              // after context injection
    Events         []agent.Event       // from claude CLI
    Result         string              // final summary
    FilesChanged   []string            // git diff
    CostUSD        float64
    SessionID      string              // claude session ID

    // Output
    PreviewURL     string
    CommitHash     string
    Error          error

    // Control
    SkipPreview    bool                // skip deploy stage
    SkipCommit     bool                // skip git commit stage

    // Notify callback
    SendProgress   func(text string)
}

func (p *Pipeline) Run(ctx context.Context, s *State) error {
    for _, stage := range p.stages {
        if p.hooks != nil && p.hooks.OnBefore != nil {
            p.hooks.OnBefore(stage.Name(), s)
        }

        if err := stage.Execute(ctx, s); err != nil {
            if p.hooks != nil && p.hooks.OnError != nil {
                if retryErr := p.hooks.OnError(stage.Name(), s, err); retryErr == nil {
                    continue // hook handled the error
                }
            }
            s.Error = err
            return fmt.Errorf("stage %s: %w", stage.Name(), err)
        }

        if p.hooks != nil && p.hooks.OnAfter != nil {
            p.hooks.OnAfter(stage.Name(), s)
        }
    }
    return nil
}

func NewDefaultPipeline(deps Dependencies) *Pipeline {
    return &Pipeline{
        stages: []Stage{
            &AuthStage{auth: deps.Auth, state: deps.Store},
            &ContextStage{memory: deps.Memory, config: deps.Config},
            &ExecuteStage{agent: deps.Agent},
            &StreamStage{budgetLimit: deps.Config.Claude.MaxBudgetPerTask},
            &CommitStage{},
            &DeployStage{preview: deps.Preview},
            &NotifyStage{},
        },
    }
}
```

### Stage Details

```go
// Stage 1: Auth & Rate Limit
type AuthStage struct{}
func (s *AuthStage) Execute(ctx context.Context, st *State) error {
    // Check user is allowed
    // Check rate limit (token bucket)
    // Check daily budget not exceeded
}

// Stage 2: Context + Memory Injection
type ContextStage struct{}
func (s *ContextStage) Execute(ctx context.Context, st *State) error {
    // Load CLAUDE.md from project
    // Load L1 project memory (last N task summaries)
    // Load L2 cross-project memory (API contracts)
    // Build enriched prompt
    // Inject agent system prompt
}

// Stage 3: Execute Claude CLI
type ExecuteStage struct{}
func (s *ExecuteStage) Execute(ctx context.Context, st *State) error {
    // os/exec: claude -p <enriched_prompt> --output-format stream-json
    // Store event reader in state
}

// Stage 4: Stream & Parse
type StreamStage struct{}
func (s *StreamStage) Execute(ctx context.Context, st *State) error {
    // Read JSON events from claude stdout
    // Forward progress to user via SendProgress callback
    // Enforce budget limit mid-stream
    // Collect result + cost
}

// Stage 5: Commit & Record
type CommitStage struct{}
func (s *CommitStage) Execute(ctx context.Context, st *State) error {
    // git diff -> detect changed files
    // git add -A && git commit
    // Save task to SQLite
    // Save memory entry (async via eventbus)
}

// Stage 6: Deploy Preview
type DeployStage struct{}
func (s *DeployStage) Execute(ctx context.Context, st *State) error {
    // if SkipPreview -> return
    // Build project
    // Start dev server
    // Health check
    // Create tunnel
    // Store preview URL
}

// Stage 7: Notify User
type NotifyStage struct{}
func (s *NotifyStage) Execute(ctx context.Context, st *State) error {
    // Format result message
    // Include: summary, files changed, cost, preview URL
    // Send via telegram
}
```

### Custom Pipeline per Project

```yaml
projects:
  ecommerce-api:
    language: java
    pipeline:
      skip_preview: false
      skip_commit: false
      hooks:
        after_commit: "mvn test"        # run tests after commit
        before_deploy: "mvn package"    # build jar before deploy
```

---

## 4. Cron System

### Bài toán

Developer muốn:
- Tự động pull code mới mỗi sáng
- Chạy tests định kỳ
- Health check preview URLs
- Scheduled code review
- Auto-build khi có commit mới

### Thiết kế

```
┌──────────────────────────────────────────────────────┐
│                    Cron Scheduler                    │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │ Job Registry                                   │  │
│  │                                                │  │
│  │  ┌─────────────┐  ┌─────────────┐             │  │
│  │  │ auto-test   │  │ health-check│             │  │
│  │  │ every 30min │  │ every 5min  │             │  │
│  │  │ mvn test    │  │ check URLs  │             │  │
│  │  └─────────────┘  └─────────────┘             │  │
│  │                                                │  │
│  │  ┌─────────────┐  ┌─────────────┐             │  │
│  │  │ git-pull    │  │ daily-review│             │  │
│  │  │ every 1h    │  │ 09:00 daily │             │  │
│  │  │ git pull    │  │ code review │             │  │
│  │  └─────────────┘  └─────────────┘             │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  Ticker goroutine → check jobs → execute → notify    │
└──────────────────────────────────────────────────────┘
```

### Implementation

```go
// internal/cron/scheduler.go
type Scheduler struct {
    jobs    map[string]*Job
    store   state.Store
    bus     *eventbus.Bus
    logger  *slog.Logger
    mu      sync.RWMutex
}

type Job struct {
    ID          string
    Name        string
    ProjectSlug string
    Schedule    Schedule
    Action      Action
    Enabled     bool
    LastRun     *time.Time
    LastResult  string
    LastStatus  JobStatus
    CreatedBy   string
}

type Schedule struct {
    Type     ScheduleType     // interval | cron | once
    Interval time.Duration    // for interval type
    Cron     string           // for cron type: "0 9 * * *"
    At       *time.Time       // for once type
}

type ScheduleType string
const (
    ScheduleInterval ScheduleType = "interval"
    ScheduleCron     ScheduleType = "cron"
    ScheduleOnce     ScheduleType = "once"
)

type Action struct {
    Type    ActionType
    Command string           // for shell type
    Prompt  string           // for agent type
    Agent   string           // agent profile to use
}

type ActionType string
const (
    ActionShell  ActionType = "shell"    // run shell command in project dir
    ActionAgent  ActionType = "agent"    // run claude agent with prompt
    ActionHealth ActionType = "health"   // check preview URL health
    ActionGitPull ActionType = "git_pull" // git pull in project dir
)

type JobStatus string
const (
    JobSuccess JobStatus = "success"
    JobFailed  JobStatus = "failed"
    JobRunning JobStatus = "running"
)
```

```go
// internal/cron/scheduler.go - core loop
func (s *Scheduler) Start(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second) // check every 30s
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case now := <-ticker.C:
            s.mu.RLock()
            for _, job := range s.jobs {
                if !job.Enabled || !s.shouldRun(job, now) {
                    continue
                }
                go s.execute(ctx, job)
            }
            s.mu.RUnlock()
        }
    }
}

func (s *Scheduler) shouldRun(job *Job, now time.Time) bool {
    if job.LastRun == nil {
        return true
    }
    switch job.Schedule.Type {
    case ScheduleInterval:
        return now.Sub(*job.LastRun) >= job.Schedule.Interval
    case ScheduleCron:
        return matchesCron(job.Schedule.Cron, now) && !sameMinute(*job.LastRun, now)
    case ScheduleOnce:
        return job.Schedule.At != nil && now.After(*job.Schedule.At) && job.LastRun == nil
    }
    return false
}

func (s *Scheduler) execute(ctx context.Context, job *Job) {
    s.logger.Info("cron job executing", "job", job.Name, "project", job.ProjectSlug)

    job.LastStatus = JobRunning
    now := time.Now()
    job.LastRun = &now

    var err error
    switch job.Action.Type {
    case ActionShell:
        err = s.executeShell(ctx, job)
    case ActionAgent:
        err = s.executeAgent(ctx, job)
    case ActionHealth:
        err = s.executeHealthCheck(ctx, job)
    case ActionGitPull:
        err = s.executeGitPull(ctx, job)
    }

    if err != nil {
        job.LastStatus = JobFailed
        job.LastResult = err.Error()
        // Notify user of failure
        s.bus.Publish(eventbus.Event{
            Type:    eventbus.EventCronFailed,
            Payload: CronFailedPayload{JobName: job.Name, Error: err.Error()},
        })
    } else {
        job.LastStatus = JobSuccess
    }
}
```

### Built-in Job Types

```go
// Shell: run command in project directory
func (s *Scheduler) executeShell(ctx context.Context, job *Job) error {
    cmd := exec.CommandContext(ctx, "sh", "-c", job.Action.Command)
    cmd.Dir = s.getProjectPath(job.ProjectSlug)
    output, err := cmd.CombinedOutput()
    job.LastResult = string(output)
    return err
}

// Agent: run claude -p with a prompt
func (s *Scheduler) executeAgent(ctx context.Context, job *Job) error {
    events, err := s.agent.Execute(ctx, agent.ExecOpts{
        Prompt:       job.Action.Prompt,
        WorkDir:      s.getProjectPath(job.ProjectSlug),
        AgentProfile: job.Action.Agent,
    })
    // consume events, collect result
}

// Health: check if preview URL is responding
func (s *Scheduler) executeHealthCheck(ctx context.Context, job *Job) error {
    url := s.preview.GetPreviewURL(job.ProjectSlug)
    if url == "" {
        return fmt.Errorf("no active preview for %s", job.ProjectSlug)
    }
    resp, err := http.Get(url)
    if err != nil {
        return fmt.Errorf("health check failed: %w", err)
    }
    resp.Body.Close()
    if resp.StatusCode >= 400 {
        return fmt.Errorf("health check returned %d", resp.StatusCode)
    }
    return nil
}

// Git Pull: pull latest changes
func (s *Scheduler) executeGitPull(ctx context.Context, job *Job) error {
    cmd := exec.CommandContext(ctx, "git", "pull", "--rebase")
    cmd.Dir = s.getProjectPath(job.ProjectSlug)
    output, err := cmd.CombinedOutput()
    job.LastResult = string(output)
    return err
}
```

### Config (static jobs)

```yaml
cron:
  jobs:
    auto-test:
      project: ecommerce-api
      schedule:
        type: interval
        interval: 30m
      action:
        type: shell
        command: "mvn test -q"

    health-check:
      project: ecommerce-api
      schedule:
        type: interval
        interval: 5m
      action:
        type: health

    morning-pull:
      project: ecommerce-api
      schedule:
        type: cron
        cron: "0 9 * * 1-5"    # 9 AM weekdays
      action:
        type: git_pull

    daily-review:
      project: ecommerce-api
      schedule:
        type: cron
        cron: "0 18 * * 1-5"   # 6 PM weekdays
      action:
        type: agent
        agent: code-reviewer
        prompt: "Review today's changes. Check for bugs, security issues, and code quality."
```

### Telegram UX (dynamic jobs)

```
/cron list                                    — List all jobs
/cron add "run tests" every 30m shell "mvn test"  — Add interval job
/cron add "review" at 18:00 agent "Review code"   — Add scheduled agent job
/cron add "pull" cron "0 9 * * *" git_pull        — Add cron job
/cron pause <name>                            — Pause a job
/cron resume <name>                           — Resume a job
/cron delete <name>                           — Delete a job
/cron run <name>                              — Run job now
/cron logs <name>                             — Show last N results
```

### SQLite Schema Addition

```sql
-- internal/state/migrations/003_cron.sql

CREATE TABLE IF NOT EXISTS cron_jobs (
    id            TEXT PRIMARY KEY,
    name          TEXT UNIQUE NOT NULL,
    project_slug  TEXT NOT NULL,
    schedule_type TEXT NOT NULL,
    schedule_value TEXT NOT NULL,       -- interval duration or cron expression
    action_type   TEXT NOT NULL,
    action_value  TEXT NOT NULL,        -- command or prompt
    agent_profile TEXT,
    enabled       INTEGER DEFAULT 1,
    last_run      TEXT,
    last_status   TEXT,
    last_result   TEXT,
    created_by    TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cron_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id      TEXT NOT NULL,
    status      TEXT NOT NULL,
    result      TEXT,
    duration_ms INTEGER,
    started_at  TEXT,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cron_logs_job ON cron_logs(job_id, started_at DESC);
```

---

## 5. Updater System

### Bài toán

- RemoteClaw cần tự update binary khi có version mới
- Projects cần auto-pull code mới từ git
- Notify user khi có update available

### Thiết kế

```
┌──────────────────────────────────────────────────────┐
│                   Updater System                     │
│                                                      │
│  ┌─────────────────┐  ┌─────────────────┐           │
│  │ Self-Updater    │  │ Project Updater │           │
│  │                 │  │                 │           │
│  │ Check GitHub    │  │ git fetch       │           │
│  │ Releases API    │  │ detect new      │           │
│  │ for new version │  │ commits         │           │
│  │                 │  │                 │           │
│  │ Download binary │  │ git pull        │           │
│  │ Replace self    │  │ rebuild deps    │           │
│  │ Restart         │  │ restart preview │           │
│  └─────────────────┘  └─────────────────┘           │
│                                                      │
│  ┌─────────────────────────────────────────┐         │
│  │ Version Manager                         │         │
│  │                                         │         │
│  │ Current: v0.2.1                         │         │
│  │ Latest:  v0.3.0                         │         │
│  │ Status:  update available               │         │
│  └─────────────────────────────────────────┘         │
└──────────────────────────────────────────────────────┘
```

### Implementation

```go
// internal/updater/self.go
type SelfUpdater struct {
    currentVersion string
    repoOwner      string  // "hale249"
    repoName       string  // "remoteclaw"
    logger         *slog.Logger
}

type Release struct {
    Version     string
    DownloadURL string
    Changelog   string
    PublishedAt time.Time
}

func (u *SelfUpdater) CheckForUpdate(ctx context.Context) (*Release, error) {
    // GET https://api.github.com/repos/hale249/remoteclaw/releases/latest
    // Compare semver with currentVersion
    // Return release info if newer
}

func (u *SelfUpdater) Update(ctx context.Context, release *Release) error {
    // 1. Download new binary to temp file
    // 2. Verify checksum (if available)
    // 3. Replace current binary (os.Rename)
    // 4. Signal restart (SIGHUP or exit with special code)
}
```

```go
// internal/updater/project.go
type ProjectUpdater struct {
    logger *slog.Logger
}

type UpdateInfo struct {
    ProjectSlug  string
    Behind       int      // commits behind remote
    NewCommits   []string // commit messages
    HasConflicts bool
}

func (u *ProjectUpdater) Check(ctx context.Context, projectPath string) (*UpdateInfo, error) {
    // git fetch origin
    // git rev-list HEAD..origin/main --count
    // git log HEAD..origin/main --oneline
}

func (u *ProjectUpdater) Pull(ctx context.Context, projectPath string) error {
    // git pull --rebase origin main
}
```

### Integration with Cron

```yaml
cron:
  jobs:
    check-updates:
      schedule:
        type: interval
        interval: 6h
      action:
        type: shell
        command: "remoteclaw update --check"  # just check, don't auto-update

    project-sync:
      project: ecommerce-api
      schedule:
        type: cron
        cron: "0 8 * * 1-5"   # 8 AM weekdays
      action:
        type: git_pull
```

### Telegram UX

```
/update check              — Check for RemoteClaw updates
/update now                — Update RemoteClaw to latest
/update project <name>     — Pull latest for a project
/update all                — Pull all projects
/version                   — Show current version + update status
```

### Build-time Version Injection

```makefile
VERSION := $(shell git describe --tags --always)
COMMIT  := $(shell git rev-parse --short HEAD)

build:
	go build -ldflags "-X main.version=$(VERSION) -X main.commit=$(COMMIT)" \
		-o bin/remoteclaw ./cmd/remoteclaw
```

```go
// cmd/remoteclaw/main.go
var (
    version = "dev"
    commit  = "unknown"
)
```

---

## 6. Updated Architecture Diagram

```
User Phone (Telegram / Slack)
         │
         v
┌────────────────────────────────────────────────────────────┐
│                  REMOTECLAW (Go binary)                    │
│                                                            │
│  Channel Layer ──> MessageBus ──> Orchestrator             │
│                                       │                    │
│                                       v                    │
│                              ┌─────────────────┐           │
│                              │    Pipeline      │           │
│                              │  (7 stages)      │           │
│                              │                  │           │
│                              │ Auth → Context   │           │
│                              │ → Execute →      │           │
│                              │ Stream → Commit  │           │
│                              │ → Deploy →       │           │
│                              │ Notify           │           │
│                              └────────┬─────────┘           │
│                                       │                    │
│  ┌──────────┐  ┌──────────┐  ┌────────v───────┐           │
│  │  Agent   │  │  Memory  │  │   EventBus     │           │
│  │ Registry │  │  System  │  │   + Workers    │           │
│  │          │  │          │  │                │           │
│  │ java-dev │  │ L0: sess │  │ GitWorker      │           │
│  │ php-dev  │  │ L1: proj │  │ PreviewWorker  │           │
│  │ go-dev   │  │ L2: cross│  │ MemoryWorker   │           │
│  │ reviewer │  │          │  │ NotifyWorker   │           │
│  └──────────┘  └──────────┘  └────────────────┘           │
│                                                            │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐           │
│  │  Cron    │  │ Updater  │  │  Preview Mgr   │           │
│  │Scheduler │  │          │  │ (ngrok/cfd)    │           │
│  │          │  │ Self     │  │                │           │
│  │ auto-test│  │ Project  │  │ Build → Health │           │
│  │ health   │  │          │  │ → Tunnel       │           │
│  │ git-pull │  │          │  │                │           │
│  └──────────┘  └──────────┘  └────────────────┘           │
│                                                            │
│  ┌─────────────────────────────────────────────┐           │
│  │             State Store (SQLite)            │           │
│  │  users | tasks | conversations | memory     │           │
│  │  cron_jobs | cron_logs | audit_log          │           │
│  └─────────────────────────────────────────────┘           │
│                                                            │
│            claude -p (trực tiếp trên host)                 │
│            ngrok / cloudflared (trực tiếp trên host)       │
│            git (trực tiếp trên host)                       │
└────────────────────────────────────────────────────────────┘
```

## 7. Implementation Priority

| # | Feature | Effort | Value | Priority |
|---|---------|--------|-------|----------|
| 1 | Pipeline (formalize stages) | Medium | High | P0 - refactor |
| 2 | Agent profiles (per project) | Low | High | P1 |
| 3 | Cron (scheduled jobs) | Medium | High | P1 |
| 4 | Memory L1 (project) | Medium | Medium | P2 |
| 5 | Updater (self + project) | Low | Medium | P2 |
| 6 | Memory L2 (cross-project) | High | Medium | P3 |
| 7 | Multi-agent delegation | High | Low (MVP) | P3 |

### Suggested Build Order

```
Phase 1 (refactor MVP):
  → Pipeline system (formalize current flow into 7 stages)
  → Agent profiles (config-driven, per project)

Phase 2 (automation):
  → Cron scheduler (interval + cron jobs)
  → Memory L1 (project-level task history)
  → Updater (version check + self-update)

Phase 3 (advanced):
  → Memory L2 (cross-project API contracts)
  → Multi-agent delegation
  → Pipeline hooks (custom before/after per project)
```
