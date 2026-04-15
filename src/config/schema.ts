import { z } from "zod";

const agentSchema = z.object({
  model: z.string().default("claude-sonnet-4-20250514"),
  system_prompt: z.string().optional(),
  max_budget_usd: z.number().default(5),
  max_turns: z.number().default(50),
  allowed_tools: z.array(z.string()).optional(),
  denied_tools: z.array(z.string()).optional(),
});

const hooksSchema = z.object({
  before_execute: z.string().optional(),
  after_execute: z.string().optional(),
  before_commit: z.string().optional(),
  after_commit: z.string().optional(),
  before_deploy: z.string().optional(),
  after_deploy: z.string().optional(),
});

const previewSchema = z.object({
  provider: z.enum(["ngrok", "cloudflared"]).default("cloudflared"),
  auto_preview: z.boolean().default(true),
  health_check_timeout_seconds: z.number().default(60),
  ngrok: z.object({ auth_token: z.string().optional() }).default({}),
  cloudflared: z.object({}).default({}),
});

const pipelineSchema = z.object({
  skip_preview: z.boolean().default(false),
  skip_commit: z.boolean().default(false),
  hooks: hooksSchema.default({}),
});

const projectSchema = z.object({
  path: z.string(),
  language: z.string().optional(),
  port: z.number().optional(),
  build: z.string().optional(),
  dev: z.string().optional(),
  agent: z.string().default("default"),
  reviewer: z.string().optional(),
  group: z.string().optional(),
  depends_on: z.array(z.string()).default([]),
  pipeline: pipelineSchema.optional(),
  preview: previewSchema.optional(),
  hooks: hooksSchema.optional(),
  env: z.record(z.string()).optional(),
});

const cronJobSchema = z.object({
  project: z.string(),
  schedule: z.object({
    type: z.enum(["interval", "cron", "once"]),
    interval: z.string().optional(),
    cron: z.string().optional(),
    at: z.string().optional(),
  }),
  action: z.object({
    type: z.enum(["shell", "agent", "health", "git_pull"]),
    command: z.string().optional(),
    prompt: z.string().optional(),
    agent: z.string().optional(),
  }),
  enabled: z.boolean().default(true),
});

export const configSchema = z.object({
  channels: z.object({
    telegram: z.object({
      bot_token: z.string(),
      mode: z.enum(["polling", "webhook"]).default("polling"),
    }).optional(),
    slack: z.object({
      bot_token: z.string(),
      app_token: z.string(),
    }).optional(),
  }),

  auth: z.object({
    allowed_telegram_ids: z.array(z.number()).default([]),
    admin_telegram_ids: z.array(z.number()).default([]),
  }),

  agents: z.record(agentSchema).default({
    default: {
      model: "claude-sonnet-4-20250514",
      max_budget_usd: 5,
      max_turns: 50,
    },
  }),

  projects: z.record(projectSchema),

  preview: previewSchema.default({}),
  pipeline: pipelineSchema.default({}),
  cron: z.object({ jobs: z.record(cronJobSchema).default({}) }).default({}),

  database: z.object({
    path: z.string().default("data/remoteclaw.db"),
  }).default({}),

  log: z.object({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
  }).default({}),
});

export type Config = z.infer<typeof configSchema>;
export type AgentConfig = z.infer<typeof agentSchema>;
export type ProjectConfig = z.infer<typeof projectSchema>;
export type HooksConfig = z.infer<typeof hooksSchema>;
export type PreviewConfig = z.infer<typeof previewSchema>;
export type PipelineConfig = z.infer<typeof pipelineSchema>;
