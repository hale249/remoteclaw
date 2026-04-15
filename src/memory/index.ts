import type { Store, MemoryType } from "../state/index.js";
import type { Config } from "../config/index.js";

export interface TaskSummary {
  date: string;
  projectSlug: string;
  prompt: string;
  result: string;
  filesChanged: number;
  costUsd: number;
  taskId?: string;
}

export class MemoryManager {
  constructor(
    private store: Store,
    private config: Config,
  ) {}

  // --- L1: Project Memory ---

  /** Record a completed task as memory */
  recordTask(summary: TaskSummary): void {
    const shortResult = summary.result.length > 120
      ? summary.result.slice(0, 120) + "..."
      : summary.result;

    this.store.addMemory({
      project_slug: summary.projectSlug,
      type: "task_summary",
      content: `[${summary.date}] ${shortResult} (${summary.filesChanged} files, $${summary.costUsd.toFixed(2)})`,
      source_task_id: summary.taskId,
    });
  }

  /** Add a manual note */
  addNote(projectSlug: string, content: string, type: MemoryType = "note"): void {
    this.store.addMemory({
      project_slug: projectSlug,
      type,
      content,
    });
  }

  /** Get project memory formatted for context injection */
  getProjectMemory(projectSlug: string): string | null {
    const entries = this.store.getMemoryByProject(projectSlug, { limit: 50 });
    if (entries.length === 0) return null;

    // Group by type
    const grouped = new Map<string, string[]>();
    for (const entry of entries) {
      const list = grouped.get(entry.type) ?? [];
      list.push(entry.content);
      grouped.set(entry.type, list);
    }

    const sections: string[] = [];

    const typeLabels: Record<string, string> = {
      task_summary: "Recent Tasks",
      known_issue: "Known Issues",
      pattern: "Patterns",
      decision: "Decisions",
      api_contract: "API Contracts",
      note: "Notes",
    };

    for (const [type, items] of grouped) {
      const label = typeLabels[type] ?? type;
      const lines = items.slice(0, 20).map((i) => `- ${i}`).join("\n");
      sections.push(`### ${label}\n${lines}`);
    }

    return sections.join("\n\n");
  }

  /** Clear all memory for a project */
  clearMemory(projectSlug: string): void {
    this.store.clearMemory(projectSlug);
  }

  // --- L2: Cross-Project Memory ---

  /** Get cross-project memory for dependencies */
  getCrossProjectMemory(dependsOn: string[]): string | null {
    if (dependsOn.length === 0) return null;

    const parts: string[] = [];

    for (const depSlug of dependsOn) {
      const depProject = this.config.projects[depSlug];
      if (!depProject) continue;

      const group = depProject.group;
      if (!group) continue;

      const entries = this.store.getCrossProjectMemory(group)
        .filter((e) => e.source_project === depSlug);

      if (entries.length === 0) {
        parts.push(`### ${depSlug} (${depProject.language ?? "?"}, port ${depProject.port ?? "?"})\nNo API info yet.`);
        continue;
      }

      const content = entries.map((e) => e.content).join("\n");
      parts.push(`### ${depSlug} (${depProject.language ?? "?"}, port ${depProject.port ?? "?"})\n${content}`);
    }

    return parts.length > 0 ? parts.join("\n\n") : null;
  }

  /** Update cross-project memory (e.g. after API changes) */
  updateCrossProjectMemory(projectSlug: string, apiInfo: string): void {
    const project = this.config.projects[projectSlug];
    if (!project?.group) return;

    this.store.addCrossProjectMemory({
      project_group: project.group,
      source_project: projectSlug,
      type: "api_contract",
      content: apiInfo,
    });
  }
}
