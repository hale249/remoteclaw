import "dotenv/config";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { loadConfig } from "./config/index.js";
import { Store } from "./state/index.js";
import { AgentRegistry, AgentRunner } from "./agent/index.js";
import { NgrokTunneler, CloudflaredTunneler, PreviewManager } from "./preview/index.js";
import { MemoryManager } from "./memory/index.js";
import { SkillRegistry } from "./skills/index.js";
import { CronScheduler } from "./cron/index.js";
import {
  Pipeline, ContextStage, ExecuteStage, CommitStage, DeployStage, RecordStage, NotifyStage,
} from "./pipeline/index.js";
import { TelegramGateway } from "./channel/telegram/index.js";
import { Orchestrator } from "./orchestrator/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = process.argv[2] ?? "config/remoteclaw.yaml";

const logger = pino({
  transport: { target: "pino-pretty", options: { colorize: true } },
});

async function main() {
  // 1. Config
  const config = loadConfig(resolve(configPath));
  logger.info({
    projects: Object.keys(config.projects).length,
    agents: Object.keys(config.agents).length,
    cronJobs: Object.keys(config.cron.jobs).length,
  }, "config loaded");

  // 2. Database
  const store = new Store(config.database.path);

  // 3. Agent
  const registry = new AgentRegistry(config.agents, config.projects);
  const runner = new AgentRunner(registry, logger.child({ component: "agent" }));

  // 4. Tunnel
  const tunneler = config.preview.provider === "ngrok"
    ? new NgrokTunneler(config.preview.ngrok.auth_token ?? "", logger.child({ component: "ngrok" }))
    : new CloudflaredTunneler(logger.child({ component: "cloudflared" }));

  // 5. Preview
  const previewMgr = new PreviewManager(tunneler, config.preview, logger.child({ component: "preview" }));

  // 6. Memory (stored in SQLite)
  const memory = new MemoryManager(store, config);

  // 7. Skills
  const skills = new SkillRegistry(logger.child({ component: "skills" }));
  const builtInSkillsDir = join(__dirname, "..", "skills");
  skills.load(builtInSkillsDir);
  // Load user skills from ~/.remoteclaw/skills/ if exists
  const homeSkillsDir = join(process.env.HOME ?? "~", ".remoteclaw", "skills");
  skills.load(homeSkillsDir);
  logger.info({ skills: skills.list().length }, "skills loaded");

  // 8. Pipeline
  const pipeline = new Pipeline([
    new ContextStage(memory, config),
    new ExecuteStage(runner),
    new CommitStage(),
    new DeployStage(previewMgr),
    new RecordStage(store, memory),
    new NotifyStage(),
  ], logger.child({ component: "pipeline" }));

  // 9. Gateway
  if (!config.channels.telegram) {
    logger.error("No channel configured. Set channels.telegram in config.");
    process.exit(1);
  }
  const gateway = new TelegramGateway(config.channels.telegram, config.auth, logger.child({ component: "telegram" }));

  // 10. Cron
  let cron: CronScheduler | null = null;
  if (Object.keys(config.cron.jobs).length > 0) {
    cron = new CronScheduler(config, runner, previewMgr, logger.child({ component: "cron" }),
      (text) => {
        // Notify first admin on cron events
        const adminId = config.auth.admin_telegram_ids[0] ?? config.auth.allowed_telegram_ids[0];
        if (adminId) gateway.send(adminId, text).catch(() => {});
      },
    );
  }

  // 11. Orchestrator
  const orchestrator = new Orchestrator(
    gateway, pipeline, registry, previewMgr, skills, memory, cron, store, config,
    logger.child({ component: "orchestrator" }),
  );
  orchestrator.start();
  gateway.start();

  logger.info("remoteclaw started");

  // Graceful shutdown
  const shutdown = () => {
    logger.info("shutting down");
    orchestrator.stop();
    gateway.stop();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  logger.error({ err }, "fatal");
  process.exit(1);
});
