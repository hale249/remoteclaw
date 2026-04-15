import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Logger } from "pino";

// --- Types ---

export interface Skill {
  name: string;
  description: string;
  trigger: string;          // /deploy, /review, etc.
  agent?: string;           // agent profile override
  instructions: string;     // full markdown body
  skipPreview?: boolean;
  skipCommit?: boolean;
}

// --- Registry ---

export class SkillRegistry {
  private skills = new Map<string, Skill>();

  constructor(private logger: Logger) {}

  /** Load skills with priority: project > user > built-in */
  load(builtInDir: string, userDir?: string) {
    // Built-in skills (lowest priority)
    this.loadFromDir(builtInDir, "built-in");

    // User skills (~/.remoteclaw/skills/)
    if (userDir) {
      this.loadFromDir(userDir, "user");
    }
  }

  /** Load project-specific skills (highest priority, called per project) */
  loadProjectSkills(projectPath: string) {
    const skillsDir = join(projectPath, ".remoteclaw", "skills");
    this.loadFromDir(skillsDir, "project");
  }

  /** Resolve a skill by trigger name (e.g. "deploy", "review") */
  resolve(trigger: string): Skill | undefined {
    // Remove leading / if present
    const name = trigger.startsWith("/") ? trigger.slice(1) : trigger;
    return this.skills.get(name);
  }

  /** List all loaded skills */
  list(): Skill[] {
    return [...this.skills.values()];
  }

  // --- Internals ---

  private loadFromDir(dir: string, source: string) {
    if (!existsSync(dir)) return;

    try {
      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const skillPath = entry.isDirectory()
          ? join(dir, entry.name, "SKILL.md")
          : entry.name.endsWith(".md")
            ? join(dir, entry.name)
            : null;

        if (!skillPath || !existsSync(skillPath)) continue;

        try {
          const skill = this.parseSkillFile(skillPath);
          this.skills.set(skill.name, skill);
          this.logger.debug({ skill: skill.name, source }, "skill loaded");
        } catch (err) {
          this.logger.warn({ path: skillPath, err }, "failed to parse skill");
        }
      }
    } catch {
      // dir doesn't exist or not readable
    }
  }

  private parseSkillFile(path: string): Skill {
    const content = readFileSync(path, "utf-8");

    // Parse YAML frontmatter (between --- markers)
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

    if (!fmMatch) {
      // No frontmatter — use filename as name, entire content as instructions
      const name = basename(path, ".md").toLowerCase();
      return {
        name,
        description: "",
        trigger: `/${name}`,
        instructions: content,
      };
    }

    const frontmatter = parseYaml(fmMatch[1]) as Record<string, any>;
    const body = fmMatch[2].trim();

    return {
      name: frontmatter.name ?? basename(path, ".md").toLowerCase(),
      description: frontmatter.description ?? "",
      trigger: frontmatter.trigger ?? `/${frontmatter.name}`,
      agent: frontmatter.agent,
      instructions: body,
      skipPreview: frontmatter.skip_preview,
      skipCommit: frontmatter.skip_commit,
    };
  }
}
