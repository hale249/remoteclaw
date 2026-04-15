import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { configSchema, type Config } from "./schema.js";

export type { Config, AgentConfig, ProjectConfig, HooksConfig, PreviewConfig, PipelineConfig } from "./schema.js";

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, "utf-8");

  // Expand ${ENV_VAR} in YAML content
  const expanded = raw.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "");

  const parsed = parse(expanded);
  return configSchema.parse(parsed);
}

export function getProjectHooks(config: Config, slug: string): Config["pipeline"]["hooks"] {
  const project = config.projects[slug];
  const base = config.pipeline.hooks;
  if (!project?.hooks) return base;

  return {
    before_execute: project.hooks.before_execute ?? base.before_execute,
    after_execute: project.hooks.after_execute ?? base.after_execute,
    before_commit: project.hooks.before_commit ?? base.before_commit,
    after_commit: project.hooks.after_commit ?? base.after_commit,
    before_deploy: project.hooks.before_deploy ?? base.before_deploy,
    after_deploy: project.hooks.after_deploy ?? base.after_deploy,
  };
}

export function getProjectPipeline(config: Config, slug: string): Config["pipeline"] {
  const project = config.projects[slug];
  return project?.pipeline ?? config.pipeline;
}

export function getProjectPreview(config: Config, slug: string): Config["preview"] {
  const project = config.projects[slug];
  return project?.preview ?? config.preview;
}
