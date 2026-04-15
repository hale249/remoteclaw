import { execSync } from "node:child_process";
import type { Config } from "../config/index.js";
import type { AgentRunner } from "../agent/index.js";
import type { PreviewManager } from "../preview/index.js";
import type { Logger } from "pino";

// --- Types ---

interface JobState {
  name: string;
  projectSlug: string;
  intervalMs?: number;
  cronExpr?: string;
  action: Config["cron"]["jobs"][string]["action"];
  enabled: boolean;
  lastRun?: Date;
  lastStatus?: "success" | "failed";
  lastResult?: string;
}

// --- Scheduler ---

export class CronScheduler {
  private jobs: Map<string, JobState> = new Map();
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private config: Config,
    private agentRunner: AgentRunner,
    private previewMgr: PreviewManager,
    private logger: Logger,
    private onNotify?: (text: string) => void,
  ) {
    this.loadJobs();
  }

  private loadJobs() {
    for (const [name, job] of Object.entries(this.config.cron.jobs)) {
      let intervalMs: number | undefined;

      if (job.schedule.type === "interval" && job.schedule.interval) {
        intervalMs = this.parseInterval(job.schedule.interval);
      }

      this.jobs.set(name, {
        name,
        projectSlug: job.project,
        intervalMs,
        cronExpr: job.schedule.cron,
        action: job.action,
        enabled: job.enabled,
      });
    }
  }

  start() {
    if (this.running) return;
    this.running = true;

    // Check jobs every 30 seconds
    this.timer = setInterval(() => this.tick(), 30_000);
    this.logger.info({ jobs: this.jobs.size }, "cron scheduler started");
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
  }

  private tick() {
    const now = new Date();

    for (const [, job] of this.jobs) {
      if (!job.enabled) continue;
      if (!this.shouldRun(job, now)) continue;

      // Run async — don't block tick
      this.execute(job).catch((err) => {
        this.logger.error({ job: job.name, err }, "cron job failed");
      });
    }
  }

  private shouldRun(job: JobState, now: Date): boolean {
    if (!job.lastRun) return true;

    if (job.intervalMs) {
      return now.getTime() - job.lastRun.getTime() >= job.intervalMs;
    }

    if (job.cronExpr) {
      return this.matchesCron(job.cronExpr, now) && !this.sameMinute(job.lastRun, now);
    }

    return false;
  }

  private async execute(job: JobState) {
    this.logger.info({ job: job.name, project: job.projectSlug }, "cron executing");
    job.lastRun = new Date();

    const project = this.config.projects[job.projectSlug];
    if (!project) {
      job.lastStatus = "failed";
      job.lastResult = `Project ${job.projectSlug} not found`;
      return;
    }

    try {
      switch (job.action.type) {
        case "shell": {
          const output = execSync(job.action.command!, { cwd: project.path, encoding: "utf-8", timeout: 120_000 });
          job.lastResult = output.slice(-500);
          job.lastStatus = "success";
          break;
        }

        case "agent": {
          const result = await this.agentRunner.execute({
            prompt: job.action.prompt!,
            workDir: project.path,
            profileName: job.action.agent ?? project.agent,
          });
          job.lastResult = result.result.slice(-500);
          job.lastStatus = "success";
          break;
        }

        case "health": {
          const url = this.previewMgr.getPreviewUrl(job.projectSlug);
          if (!url) throw new Error("No active preview");
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          resp.body?.cancel();
          job.lastResult = `OK (${resp.status})`;
          job.lastStatus = "success";
          break;
        }

        case "git_pull": {
          const output = execSync("git pull --rebase", { cwd: project.path, encoding: "utf-8", timeout: 60_000 });
          job.lastResult = output.trim();
          job.lastStatus = "success";
          break;
        }
      }

      this.logger.info({ job: job.name, status: job.lastStatus }, "cron completed");
    } catch (err: any) {
      job.lastStatus = "failed";
      job.lastResult = err.message ?? String(err);
      this.logger.error({ job: job.name, err: job.lastResult }, "cron failed");

      // Notify on failure
      this.onNotify?.(`Cron <b>${job.name}</b> failed:\n<code>${job.lastResult}</code>`);
    }
  }

  /** Get job status for /cron command */
  getStatus(): Array<{ name: string; enabled: boolean; lastRun?: string; lastStatus?: string }> {
    return [...this.jobs.values()].map((j) => ({
      name: j.name,
      enabled: j.enabled,
      lastRun: j.lastRun?.toISOString(),
      lastStatus: j.lastStatus,
    }));
  }

  // --- Helpers ---

  private parseInterval(s: string): number {
    const match = s.match(/^(\d+)(s|m|h)$/);
    if (!match) return 60_000;
    const [, n, unit] = match;
    const multiplier = { s: 1000, m: 60_000, h: 3_600_000 }[unit!] ?? 60_000;
    return parseInt(n!) * multiplier;
  }

  private matchesCron(expr: string, now: Date): boolean {
    // Simple cron: "minute hour dom month dow"
    const parts = expr.split(/\s+/);
    if (parts.length < 5) return false;

    const checks = [
      { value: now.getMinutes(), pattern: parts[0]! },
      { value: now.getHours(), pattern: parts[1]! },
      { value: now.getDate(), pattern: parts[2]! },
      { value: now.getMonth() + 1, pattern: parts[3]! },
      { value: now.getDay(), pattern: parts[4]! },
    ];

    return checks.every(({ value, pattern }) => this.matchesCronField(value, pattern));
  }

  private matchesCronField(value: number, pattern: string): boolean {
    if (pattern === "*") return true;

    // Handle ranges: 1-5
    if (pattern.includes("-")) {
      const [lo, hi] = pattern.split("-").map(Number);
      return value >= lo! && value <= hi!;
    }

    // Handle lists: 1,3,5
    if (pattern.includes(",")) {
      return pattern.split(",").map(Number).includes(value);
    }

    // Handle step: */5
    if (pattern.startsWith("*/")) {
      const step = parseInt(pattern.slice(2));
      return value % step === 0;
    }

    return parseInt(pattern) === value;
  }

  private sameMinute(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate()
      && a.getHours() === b.getHours()
      && a.getMinutes() === b.getMinutes();
  }
}
