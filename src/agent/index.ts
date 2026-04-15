import { query, type SDKMessage, type SDKResultMessage, type SDKAssistantMessage, type Options } from "@anthropic-ai/claude-code";
import type { AgentConfig, Config } from "../config/index.js";
import type { Logger } from "pino";

// --- Agent Profile ---

export interface AgentProfile {
  name: string;
  model: string;
  systemPrompt?: string;
  maxBudgetUsd: number;
  maxTurns: number;
  allowedTools?: string[];
  deniedTools?: string[];
}

// --- Registry ---

export class AgentRegistry {
  private profiles: Map<string, AgentProfile> = new Map();
  private projectBindings: Map<string, string> = new Map();

  constructor(agents: Config["agents"], projects: Config["projects"]) {
    for (const [name, cfg] of Object.entries(agents)) {
      this.profiles.set(name, {
        name,
        model: cfg.model,
        systemPrompt: cfg.system_prompt,
        maxBudgetUsd: cfg.max_budget_usd,
        maxTurns: cfg.max_turns,
        allowedTools: cfg.allowed_tools,
        deniedTools: cfg.denied_tools,
      });
    }

    for (const [slug, project] of Object.entries(projects)) {
      this.projectBindings.set(slug, project.agent);
    }
  }

  get(name: string): AgentProfile {
    const profile = this.profiles.get(name);
    if (!profile) throw new Error(`Agent profile "${name}" not found`);
    return profile;
  }

  getForProject(slug: string): AgentProfile {
    const agentName = this.projectBindings.get(slug) ?? "default";
    return this.get(agentName);
  }

  list(): string[] {
    return [...this.profiles.keys()];
  }
}

// --- Runner ---

export interface ExecOpts {
  prompt: string;
  workDir: string;
  profileName: string;
  sessionId?: string;
  extraSystemPrompt?: string;
}

export interface ExecResult {
  result: string;
  costUsd: number;
  sessionId?: string;
}

export class AgentRunner {
  constructor(
    private registry: AgentRegistry,
    private logger: Logger,
  ) {}

  async execute(
    opts: ExecOpts,
    onProgress?: (text: string) => void,
    abortController?: AbortController,
  ): Promise<ExecResult> {
    const profile = this.registry.get(opts.profileName);

    const options: Options = {
      model: profile.model,
      maxTurns: profile.maxTurns,
      cwd: opts.workDir,
      abortController,
    };

    // System prompt
    let systemPrompt = profile.systemPrompt ?? "";
    if (opts.extraSystemPrompt) {
      systemPrompt = systemPrompt ? `${systemPrompt}\n\n${opts.extraSystemPrompt}` : opts.extraSystemPrompt;
    }
    if (systemPrompt) {
      options.customSystemPrompt = systemPrompt;
    }

    // Session resume
    if (opts.sessionId) {
      options.resume = opts.sessionId;
    }

    // Tool permissions
    if (profile.allowedTools?.length) {
      options.allowedTools = profile.allowedTools;
    }
    if (profile.deniedTools?.length) {
      options.disallowedTools = profile.deniedTools;
    }

    this.logger.info({ agent: profile.name, model: profile.model, workDir: opts.workDir }, "claude starting");

    // query() returns AsyncGenerator<SDKMessage>
    const stream = query({ prompt: opts.prompt, options });

    let result = "";
    let costUsd = 0;
    let sessionId: string | undefined;
    let lastProgressTime = 0;

    for await (const msg of stream) {
      // Track session ID from any message
      if ("session_id" in msg) {
        sessionId = msg.session_id;
      }

      switch (msg.type) {
        case "assistant": {
          const assistantMsg = msg as SDKAssistantMessage;
          if (onProgress && Date.now() - lastProgressTime > 3000) {
            const textBlocks = (assistantMsg.message.content as any[])?.filter(
              (c: any) => c.type === "text",
            );
            const text = textBlocks?.map((b: any) => b.text).join("") ?? "";
            if (text) {
              const preview = text.length > 200 ? text.slice(0, 200) + "..." : text;
              onProgress(preview);
              lastProgressTime = Date.now();
            }
          }
          break;
        }

        case "result": {
          const resultMsg = msg as SDKResultMessage;
          costUsd = resultMsg.total_cost_usd;
          if (resultMsg.subtype === "success") {
            result = resultMsg.result;
          } else {
            // error_max_turns | error_during_execution
            this.logger.warn({ subtype: resultMsg.subtype, costUsd: resultMsg.total_cost_usd }, "claude execution error");
            result = `[Error: ${resultMsg.subtype}]`;
          }
          break;
        }

        case "system":
          // init or compact_boundary — log for debugging
          this.logger.debug({ subtype: (msg as any).subtype }, "system message");
          break;
      }
    }

    this.logger.info({ agent: profile.name, costUsd: costUsd.toFixed(3) }, "claude completed");

    return { result, costUsd, sessionId };
  }
}
