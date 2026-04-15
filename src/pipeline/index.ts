import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { AgentRunner } from "../agent/index.js";
import type { PreviewManager } from "../preview/index.js";
import type { MemoryManager } from "../memory/index.js";
import type { Skill } from "../skills/index.js";
import type { Store, Task } from "../state/index.js";
import type { ProjectConfig, HooksConfig, Config } from "../config/index.js";
import type { Logger } from "pino";

// --- Pipeline State ---

export interface PipelineState {
  userId: string;
  prompt: string;
  project: ProjectConfig;
  projectSlug: string;
  agentProfile: string;
  skill?: Skill;            // active skill (if triggered via /command)

  // Built during pipeline
  enrichedPrompt: string;
  result: string;
  filesChanged: string[];
  costUsd: number;
  sessionId?: string;
  previewUrl?: string;
  commitHash?: string;
  error?: Error;

  // Config
  skipPreview: boolean;
  skipCommit: boolean;
  hooks: HooksConfig;

  // Callbacks
  sendProgress: (text: string) => void;

  // Task record
  task?: Task;
}

// --- Stage Interface ---

export interface Stage {
  name: string;
  execute(state: PipelineState): Promise<void>;
}

// --- Pipeline ---

export class Pipeline {
  constructor(
    private stages: Stage[],
    private logger: Logger,
  ) {}

  async run(state: PipelineState): Promise<void> {
    for (const stage of this.stages) {
      this.logger.info({ stage: stage.name, project: state.projectSlug }, "stage starting");
      const start = Date.now();

      try {
        await stage.execute(state);
      } catch (err) {
        state.error = err as Error;
        this.logger.error({ stage: stage.name, err }, "stage failed");
        throw err;
      }

      this.logger.info({ stage: stage.name, duration: Date.now() - start }, "stage completed");
    }
  }
}

// --- Stage 1: Context ---

export class ContextStage implements Stage {
  name = "context";

  constructor(
    private memory: MemoryManager,
    private config: Config,
  ) {}

  async execute(state: PipelineState) {
    const parts: string[] = [];

    // 1. Read CLAUDE.md
    try {
      const claudeMd = readFileSync(join(state.project.path, "CLAUDE.md"), "utf-8");
      parts.push(`## Project Context\n${claudeMd}`);
    } catch { /* no CLAUDE.md */ }

    // 2. L1 Project Memory (from SQLite)
    const projectMem = this.memory.getProjectMemory(state.projectSlug);
    if (projectMem) {
      parts.push(`## Project Memory\n${projectMem}`);
    }

    // 3. L2 Cross-Project Memory (from SQLite)
    if (state.project.depends_on.length > 0) {
      const crossMem = this.memory.getCrossProjectMemory(state.project.depends_on);
      if (crossMem) {
        parts.push(`## Related Projects\n${crossMem}`);
      }
    }

    // 4. Skill instructions (if a skill is active)
    if (state.skill) {
      parts.push(`## Skill: ${state.skill.name}\n${state.skill.instructions}`);
    }

    // 5. User's prompt
    parts.push(`## Task\n${state.prompt}`);

    state.enrichedPrompt = parts.join("\n\n");
  }
}

// --- Stage 2: Execute ---

export class ExecuteStage implements Stage {
  name = "execute";

  constructor(private runner: AgentRunner) {}

  async execute(state: PipelineState) {
    if (state.hooks.before_execute) {
      runHook(state.project.path, state.hooks.before_execute);
    }

    const result = await this.runner.execute(
      {
        prompt: state.enrichedPrompt,
        workDir: state.project.path,
        profileName: state.agentProfile,
        sessionId: state.sessionId,
      },
      state.sendProgress,
    );

    state.result = result.result;
    state.costUsd = result.costUsd;
    state.sessionId = result.sessionId;

    if (state.hooks.after_execute) {
      runHook(state.project.path, state.hooks.after_execute);
    }
  }
}

// --- Stage 3: Commit ---

export class CommitStage implements Stage {
  name = "commit";

  async execute(state: PipelineState) {
    if (state.skipCommit) return;

    try {
      const diff = execSync("git diff --name-only", { cwd: state.project.path, encoding: "utf-8" });
      const untracked = execSync("git ls-files --others --exclude-standard", { cwd: state.project.path, encoding: "utf-8" });
      state.filesChanged = [...diff.split("\n"), ...untracked.split("\n")].filter(Boolean);
    } catch { /* not a git repo */ }

    if (state.filesChanged.length === 0) return;

    if (state.hooks.before_commit) {
      runHook(state.project.path, state.hooks.before_commit);
    }

    try {
      execSync("git add -A", { cwd: state.project.path });
      const summary = state.result.length > 72 ? state.result.slice(0, 72) : state.result;
      execSync(`git commit -m "[remoteclaw] ${summary.replace(/"/g, '\\"')}"`, { cwd: state.project.path });
      state.commitHash = execSync("git rev-parse --short HEAD", { cwd: state.project.path, encoding: "utf-8" }).trim();
    } catch { /* commit failed */ }

    if (state.hooks.after_commit) {
      runHook(state.project.path, state.hooks.after_commit);
    }
  }
}

// --- Stage 4: Deploy ---

export class DeployStage implements Stage {
  name = "deploy";

  constructor(private previewMgr: PreviewManager) {}

  async execute(state: PipelineState) {
    if (state.skipPreview || !state.project.dev) return;

    if (state.hooks.before_deploy) {
      runHook(state.project.path, state.hooks.before_deploy);
    }

    try {
      state.previewUrl = await this.previewMgr.deploy(state.project);
    } catch (err) {
      state.sendProgress(`Preview failed: ${err}`);
    }

    if (state.hooks.after_deploy) {
      runHook(state.project.path, state.hooks.after_deploy);
    }
  }
}

// --- Stage 5: Record ---

export class RecordStage implements Stage {
  name = "record";

  constructor(
    private store: Store,
    private memory: MemoryManager,
  ) {}

  async execute(state: PipelineState) {
    // Update task in DB
    if (state.task) {
      this.store.updateTask({
        id: state.task.id,
        status: "completed",
        result_summary: state.result,
        files_changed: state.filesChanged,
        preview_url: state.previewUrl,
        claude_session_id: state.sessionId,
        cost_usd: state.costUsd,
        completed_at: new Date().toISOString(),
      });
    }

    // Write L1 memory to SQLite
    this.memory.recordTask({
      date: new Date().toISOString().split("T")[0]!,
      projectSlug: state.projectSlug,
      prompt: state.prompt,
      result: state.result,
      filesChanged: state.filesChanged.length,
      costUsd: state.costUsd,
      taskId: state.task?.id,
    });

    // Audit
    this.store.logAction(state.userId, "task.completed",
      `project=${state.projectSlug} cost=$${state.costUsd.toFixed(2)} files=${state.filesChanged.length}`);
  }
}

// --- Stage 6: Notify ---

export class NotifyStage implements Stage {
  name = "notify";

  async execute(state: PipelineState) {
    const parts: string[] = [];
    const label = state.skill ? `${state.skill.name} done` : "Done";
    parts.push(`<b>${label}!</b> [${state.projectSlug}]`);

    if (state.result) {
      const r = state.result.length > 1000 ? state.result.slice(0, 1000) + "..." : state.result;
      parts.push(r);
    }
    if (state.filesChanged.length > 0) parts.push(`<b>Files:</b> ${state.filesChanged.length} changed`);
    if (state.commitHash) parts.push(`<b>Commit:</b> <code>${state.commitHash}</code>`);
    if (state.costUsd > 0) parts.push(`<b>Cost:</b> $${state.costUsd.toFixed(2)}`);
    if (state.previewUrl) parts.push(`<b>Preview:</b> ${state.previewUrl}`);

    state.sendProgress(parts.join("\n"));
  }
}

// --- Helper ---

function runHook(cwd: string, command: string) {
  try {
    execSync(command, { cwd, stdio: "pipe", timeout: 60_000 });
  } catch { /* hook failure is non-fatal */ }
}
