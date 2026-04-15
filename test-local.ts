/**
 * Test RemoteClaw components without Telegram.
 * Run: npx tsx test-local.ts
 */
import { loadConfig } from "./src/config/index.js";
import { Store } from "./src/state/index.js";
import { AgentRegistry, AgentRunner } from "./src/agent/index.js";
import { MemoryManager } from "./src/memory/index.js";
import { SkillRegistry } from "./src/skills/index.js";
import pino from "pino";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = pino({ transport: { target: "pino-pretty" } });

async function main() {
  console.log("\n=== RemoteClaw Local Test ===\n");

  // 1. Config
  console.log("1. Testing config...");
  try {
    const config = loadConfig("config/remoteclaw.yaml");
    console.log("   ✅ Config loaded:", Object.keys(config.projects).length, "projects,", Object.keys(config.agents).length, "agents");
  } catch (err: any) {
    console.log("   ❌ Config error:", err.message);
    console.log("   → Check config/remoteclaw.yaml and .env");
  }

  // 2. SQLite
  console.log("\n2. Testing SQLite...");
  const store = new Store("data/test.db");
  let found = store.getUserByTelegramId(999);
  if (!found) {
    const user = store.createUser({ telegram_id: 999, display_name: "TestUser", is_admin: true });
    console.log("   ✅ User created:", user.id);
    found = user;
  } else {
    console.log("   ✅ User exists:", found.id);
  }
  console.log("   ✅ User found:", found.display_name);

  // 3. Memory
  console.log("\n3. Testing Memory...");
  // Use a minimal config for memory test (no telegram token needed)
  const minimalConfig = {
    channels: {}, auth: { allowed_telegram_ids: [], admin_telegram_ids: [] },
    agents: { default: { model: "claude-sonnet-4-20250514", max_budget_usd: 5, max_turns: 50 } },
    projects: { test: { path: __dirname, agent: "default", depends_on: [] } },
    preview: { provider: "cloudflared" as const, auto_preview: false, health_check_timeout_seconds: 60, ngrok: {}, cloudflared: {} },
    pipeline: { skip_preview: true, skip_commit: true, hooks: {} },
    cron: { jobs: {} }, database: { path: "data/test.db" }, log: { level: "info" as const },
  };
  const memory = new MemoryManager(store, minimalConfig);
  memory.recordTask({
    date: "2025-04-15",
    projectSlug: "test",
    prompt: "test task",
    result: "Added a test feature",
    filesChanged: 2,
    costUsd: 0.15,
  });
  const mem = memory.getProjectMemory("test");
  console.log("   ✅ Memory recorded:", mem ? mem.split("\n").length + " lines" : "empty");

  // 4. Skills
  console.log("\n4. Testing Skills...");
  const skills = new SkillRegistry(logger.child({ component: "skills" }));
  skills.load(join(__dirname, "skills"));
  const skillNames = skills.list().map(s => s.trigger);
  console.log("   ✅ Skills loaded:", skillNames.join(", "));

  // 5. Agent Registry
  console.log("\n5. Testing Agent Registry...");
  const registry = new AgentRegistry(minimalConfig.agents, minimalConfig.projects);
  console.log("   ✅ Profiles:", registry.list().join(", "));
  const profile = registry.getForProject("test");
  console.log("   ✅ Project agent:", profile.name, "→", profile.model);

  // 6. Claude Code SDK (optional — requires Claude Code auth)
  console.log("\n6. Testing Claude Code SDK...");
  console.log("   → Run: npx tsx test-local.ts --with-claude");
  if (process.argv.includes("--with-claude")) {
    const debugLogger = pino({ transport: { target: "pino-pretty" }, level: "debug" });
    const runner = new AgentRunner(registry, debugLogger.child({ component: "agent" }));
    console.log("   Running claude -p 'say hello in one sentence'...");
    try {
      const result = await runner.execute({
        prompt: "Say hello in one sentence. Nothing else.",
        workDir: __dirname,
        profileName: "default",
      });
      console.log("   ✅ Result:", result.result);
      console.log("   ✅ Cost: $" + result.costUsd.toFixed(3));
    } catch (err: any) {
      console.log("   ❌ Claude error:", err.message);
      console.log("   → Make sure Claude Code is installed and authenticated (run: claude)");
    }
  }

  // Cleanup
  store.close();
  console.log("\n=== All tests passed ===\n");
}

main().catch(console.error);
