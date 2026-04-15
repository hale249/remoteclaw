import type { Gateway, InboundMessage } from "../channel/types.js";
import type { AgentRegistry } from "../agent/index.js";
import type { PreviewManager } from "../preview/index.js";
import type { SkillRegistry } from "../skills/index.js";
import type { MemoryManager } from "../memory/index.js";
import type { CronScheduler } from "../cron/index.js";
import type { Pipeline, PipelineState } from "../pipeline/index.js";
import type { Store, User } from "../state/index.js";
import type { Config } from "../config/index.js";
import { getProjectHooks, getProjectPipeline } from "../config/index.js";
import type { Logger } from "pino";

export class Orchestrator {
  private activeProject = new Map<number, string>();

  constructor(
    private gateway: Gateway,
    private pipeline: Pipeline,
    private agents: AgentRegistry,
    private previewMgr: PreviewManager,
    private skills: SkillRegistry,
    private memory: MemoryManager,
    private cron: CronScheduler | null,
    private store: Store,
    private config: Config,
    private logger: Logger,
  ) {}

  start() {
    this.gateway.onMessage((msg) => {
      this.handleMessage(msg).catch((err) =>
        this.logger.error({ err }, "message handler error"),
      );
    });
    this.cron?.start();
  }

  stop() {
    this.cron?.stop();
  }

  private async handleMessage(msg: InboundMessage) {
    const user = this.ensureUser(msg);

    if (msg.isCommand) {
      await this.handleCommand(msg, user);
      return;
    }

    // Check if text starts with /skill trigger
    const skillTrigger = msg.text.match(/^\/(\w+)/)?.[1];
    if (skillTrigger) {
      const skill = this.skills.resolve(skillTrigger);
      if (skill) {
        const args = msg.text.slice(skillTrigger.length + 1).trim();
        await this.handleSkill(msg, user, skill.name, args);
        return;
      }
    }

    await this.handleTask(msg, user);
  }

  // --- Commands ---

  private async handleCommand(msg: InboundMessage, user: User) {
    switch (msg.command) {
      case "projects": return this.cmdProjects(msg);
      case "switch": return this.cmdSwitch(msg);
      case "preview": return this.cmdPreview(msg);
      case "status": return this.cmdStatus(msg);
      case "agents": return this.cmdAgents(msg);
      case "skills": return this.cmdSkills(msg);
      case "cost": return this.cmdCost(msg, user);
      case "memory": return this.cmdMemory(msg);
      case "cron": return this.cmdCron(msg);
      default: {
        // Check if command is a skill trigger
        const skill = this.skills.resolve(msg.command!);
        if (skill) {
          await this.handleSkill(msg, user, skill.name, msg.args ?? "");
        }
      }
    }
  }

  private async cmdProjects(msg: InboundMessage) {
    const active = this.activeProject.get(msg.telegramId);
    const lines = Object.entries(this.config.projects).map(([slug, p]) => {
      const marker = slug === active ? "→ " : "  ";
      return `${marker}<b>${slug}</b> (${p.language ?? "?"}) agent:${p.agent}`;
    });
    await this.gateway.send(msg.chatId, `<b>Projects:</b>\n\n${lines.join("\n")}`);
  }

  private async cmdSwitch(msg: InboundMessage) {
    const slug = msg.args?.trim();
    if (!slug || !this.config.projects[slug]) {
      await this.gateway.send(msg.chatId, slug ? `Project <b>${slug}</b> not found.` : "Usage: /switch &lt;name&gt;");
      return;
    }
    this.activeProject.set(msg.telegramId, slug);
    const p = this.config.projects[slug];
    await this.gateway.send(msg.chatId, `Switched to <b>${slug}</b> (${p.language}, agent: ${p.agent})`);
  }

  private async cmdPreview(msg: InboundMessage) {
    const slug = this.getSlug(msg);
    if (!slug) return;
    const url = this.previewMgr.getPreviewUrl(slug);
    await this.gateway.send(msg.chatId, url ? `<b>${slug}</b>:\n${url}` : `No preview for <b>${slug}</b>.`);
  }

  private async cmdStatus(msg: InboundMessage) {
    const slug = this.getSlug(msg);
    if (!slug) return;
    const p = this.config.projects[slug];
    const pipe = getProjectPipeline(this.config, slug);
    const url = this.previewMgr.getPreviewUrl(slug);
    await this.gateway.send(msg.chatId,
      `<b>${slug}</b>\nLang: ${p.language} | Port: ${p.port} | Agent: ${p.agent}\n` +
      `Commit: ${!pipe.skip_commit} | Preview: ${!pipe.skip_preview}\n` +
      `Preview URL: ${url ?? "—"}\nPath: <code>${p.path}</code>`,
    );
  }

  private async cmdAgents(msg: InboundMessage) {
    const lines = this.agents.list().map((name) => {
      const p = this.agents.get(name);
      return `<b>${name}</b> — ${p.model} ($${p.maxBudgetUsd}, ${p.maxTurns}t)`;
    });
    await this.gateway.send(msg.chatId, `<b>Agents:</b>\n\n${lines.join("\n")}`);
  }

  private async cmdSkills(msg: InboundMessage) {
    const all = this.skills.list();
    if (all.length === 0) {
      await this.gateway.send(msg.chatId, "No skills loaded.");
      return;
    }
    const lines = all.map((s) => `<b>${s.trigger}</b> — ${s.description}`);
    await this.gateway.send(msg.chatId, `<b>Skills:</b>\n\n${lines.join("\n")}`);
  }

  private async cmdCost(msg: InboundMessage, user: User) {
    const cost = this.store.getDailyCost(user.id);
    await this.gateway.send(msg.chatId, `<b>Today:</b> $${cost.toFixed(2)}`);
  }

  private async cmdMemory(msg: InboundMessage) {
    const slug = this.getSlug(msg);
    if (!slug) return;

    const action = msg.args?.trim();

    if (action === "clear") {
      this.memory.clearMemory(slug);
      await this.gateway.send(msg.chatId, `Memory cleared for <b>${slug}</b>.`);
      return;
    }

    if (action && action !== "clear") {
      // /memory add <note> → add a note
      const noteMatch = action.match(/^add\s+(.+)/);
      if (noteMatch) {
        this.memory.addNote(slug, noteMatch[1]!);
        await this.gateway.send(msg.chatId, `Note added to <b>${slug}</b> memory.`);
        return;
      }
    }

    const mem = this.memory.getProjectMemory(slug);
    if (!mem) {
      await this.gateway.send(msg.chatId, `No memory for <b>${slug}</b> yet.`);
      return;
    }
    const display = mem.length > 3000 ? mem.slice(0, 3000) + "\n..." : mem;
    await this.gateway.send(msg.chatId, `<b>Memory [${slug}]:</b>\n\n<pre>${escapeHtml(display)}</pre>`);
  }

  private async cmdCron(msg: InboundMessage) {
    if (!this.cron) {
      await this.gateway.send(msg.chatId, "Cron not configured.");
      return;
    }
    const status = this.cron.getStatus();
    if (status.length === 0) {
      await this.gateway.send(msg.chatId, "No cron jobs.");
      return;
    }
    const lines = status.map((j) =>
      `${j.enabled ? "●" : "○"} <b>${j.name}</b> — ${j.lastStatus ?? "never run"}`,
    );
    await this.gateway.send(msg.chatId, `<b>Cron Jobs:</b>\n\n${lines.join("\n")}`);
  }

  // --- Skill Execution ---

  private async handleSkill(msg: InboundMessage, user: User, skillName: string, args: string) {
    const slug = this.getSlug(msg);
    if (!slug) return;

    const skill = this.skills.resolve(skillName);
    if (!skill) {
      await this.gateway.send(msg.chatId, `Skill <b>${skillName}</b> not found. Use /skills to list.`);
      return;
    }

    const project = this.config.projects[slug]!;
    const pipeCfg = getProjectPipeline(this.config, slug);
    const hooks = getProjectHooks(this.config, slug);

    const agentProfile = skill.agent ?? project.reviewer ?? project.agent;
    const prompt = args || skill.description;

    const task = this.store.createTask({
      user_id: user.id,
      project_slug: slug,
      prompt: `[${skill.trigger}] ${prompt}`,
      status: "running",
      cost_usd: 0,
    });

    await this.gateway.send(msg.chatId, `Running <b>${skill.trigger}</b> on <b>${slug}</b> (agent: ${agentProfile})...`);

    const state: PipelineState = {
      userId: user.id,
      prompt,
      project,
      projectSlug: slug,
      agentProfile,
      skill,
      enrichedPrompt: "",
      result: "",
      filesChanged: [],
      costUsd: 0,
      skipPreview: skill.skipPreview ?? pipeCfg.skip_preview,
      skipCommit: skill.skipCommit ?? pipeCfg.skip_commit,
      hooks,
      task,
      sendProgress: (text) => { this.gateway.send(msg.chatId, text).catch(() => {}); },
    };

    try {
      await this.pipeline.run(state);
    } catch (err) {
      this.store.updateTask({ id: task.id, status: "failed", result_summary: String(err), completed_at: new Date().toISOString() });
      await this.gateway.send(msg.chatId, `Skill failed: ${err}`);
    }
  }

  // --- Free Text Task ---

  private async handleTask(msg: InboundMessage, user: User) {
    const slug = this.getSlug(msg);
    if (!slug) return;

    const project = this.config.projects[slug]!;
    const pipeCfg = getProjectPipeline(this.config, slug);
    const hooks = getProjectHooks(this.config, slug);

    const task = this.store.createTask({
      user_id: user.id,
      project_slug: slug,
      prompt: msg.text,
      status: "running",
      cost_usd: 0,
    });

    await this.gateway.send(msg.chatId, `Working on <b>${slug}</b> (agent: ${project.agent})...`);

    const state: PipelineState = {
      userId: user.id,
      prompt: msg.text,
      project,
      projectSlug: slug,
      agentProfile: project.agent,
      enrichedPrompt: "",
      result: "",
      filesChanged: [],
      costUsd: 0,
      skipPreview: pipeCfg.skip_preview,
      skipCommit: pipeCfg.skip_commit,
      hooks,
      task,
      sendProgress: (text) => { this.gateway.send(msg.chatId, text).catch(() => {}); },
    };

    try {
      await this.pipeline.run(state);
    } catch (err) {
      this.store.updateTask({ id: task.id, status: "failed", result_summary: String(err), completed_at: new Date().toISOString() });
      await this.gateway.send(msg.chatId, `Failed: ${err}`);
    }
  }

  // --- Helpers ---

  private ensureUser(msg: InboundMessage): User {
    let user = this.store.getUserByTelegramId(msg.telegramId);
    if (user) return user;
    return this.store.createUser({
      telegram_id: msg.telegramId,
      display_name: msg.userName,
      is_admin: this.config.auth.admin_telegram_ids.includes(msg.telegramId),
    });
  }

  private getSlug(msg: InboundMessage): string | undefined {
    let slug = this.activeProject.get(msg.telegramId);
    if (slug) return slug;

    const slugs = Object.keys(this.config.projects);
    if (slugs.length === 1) {
      slug = slugs[0]!;
      this.activeProject.set(msg.telegramId, slug);
      return slug;
    }

    this.gateway.send(msg.chatId, "No active project. Use /switch &lt;name&gt;").catch(() => {});
    return undefined;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
