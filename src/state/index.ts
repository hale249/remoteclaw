import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// --- Models ---

export interface User {
  id: string;
  telegram_id: number;
  display_name: string;
  is_admin: boolean;
}

export interface Task {
  id: string;
  user_id: string;
  project_slug: string;
  prompt: string;
  status: "pending" | "running" | "completed" | "failed";
  result_summary?: string;
  files_changed?: string[];
  preview_url?: string;
  claude_session_id?: string;
  cost_usd: number;
  started_at?: string;
  completed_at?: string;
  created_at: string;
}

export interface Conversation {
  id: string;
  user_id: string;
  project_slug: string;
  platform_chat_id: string;
  platform_thread_id?: string;
  claude_session_id?: string;
  is_active: boolean;
}

// --- Memory Models ---

export type MemoryType = "task_summary" | "known_issue" | "pattern" | "decision" | "api_contract" | "note";

export interface MemoryEntry {
  id: string;
  project_slug: string;
  type: MemoryType;
  content: string;
  source_task_id?: string;
  created_at: string;
}

export interface CrossProjectEntry {
  id: string;
  project_group: string;
  source_project: string;
  type: string;
  content: string;
  created_at: string;
}

// --- Store ---

export class Store {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        telegram_id   INTEGER UNIQUE,
        display_name  TEXT NOT NULL,
        is_admin      INTEGER DEFAULT 0,
        created_at    TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id                TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL,
        project_slug      TEXT NOT NULL,
        prompt            TEXT NOT NULL,
        status            TEXT DEFAULT 'pending',
        result_summary    TEXT,
        files_changed     TEXT,
        preview_url       TEXT,
        claude_session_id TEXT,
        cost_usd          REAL DEFAULT 0,
        started_at        TEXT,
        completed_at      TEXT,
        created_at        TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id                  TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL,
        project_slug        TEXT NOT NULL,
        platform_chat_id    TEXT NOT NULL,
        platform_thread_id  TEXT,
        claude_session_id   TEXT,
        is_active           INTEGER DEFAULT 1,
        created_at          TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, project_slug, platform_chat_id, platform_thread_id)
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     TEXT,
        action      TEXT NOT NULL,
        details     TEXT,
        created_at  TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS memory_entries (
        id              TEXT PRIMARY KEY,
        project_slug    TEXT NOT NULL,
        type            TEXT NOT NULL,
        content         TEXT NOT NULL,
        source_task_id  TEXT,
        created_at      TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS cross_project_memory (
        id              TEXT PRIMARY KEY,
        project_group   TEXT NOT NULL,
        source_project  TEXT NOT NULL,
        type            TEXT NOT NULL,
        content         TEXT NOT NULL,
        created_at      TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_slug, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_conversations_lookup ON conversations(user_id, project_slug, platform_thread_id);
      CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_entries(project_slug, type, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cross_memory_group ON cross_project_memory(project_group, created_at DESC);
    `);
  }

  // --- Users ---

  getUserByTelegramId(telegramId: number): User | undefined {
    return this.db
      .prepare("SELECT id, telegram_id, display_name, is_admin FROM users WHERE telegram_id = ?")
      .get(telegramId) as User | undefined;
  }

  createUser(user: Omit<User, "id"> & { id?: string }): User {
    const id = user.id ?? randomUUID();
    this.db
      .prepare("INSERT INTO users (id, telegram_id, display_name, is_admin) VALUES (?, ?, ?, ?)")
      .run(id, user.telegram_id, user.display_name, user.is_admin ? 1 : 0);
    return { ...user, id } as User;
  }

  // --- Tasks ---

  createTask(task: Omit<Task, "id" | "created_at"> & { id?: string }): Task {
    const id = task.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO tasks (id, user_id, project_slug, prompt, status, started_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(id, task.user_id, task.project_slug, task.prompt, task.status);
    return { ...task, id, created_at: new Date().toISOString() } as Task;
  }

  updateTask(task: Partial<Task> & { id: string }) {
    const filesJson = task.files_changed ? JSON.stringify(task.files_changed) : null;
    this.db
      .prepare(
        `UPDATE tasks SET status=?, result_summary=?, files_changed=?, preview_url=?,
         claude_session_id=?, cost_usd=?, completed_at=? WHERE id=?`,
      )
      .run(
        task.status, task.result_summary, filesJson, task.preview_url,
        task.claude_session_id, task.cost_usd, task.completed_at, task.id,
      );
  }

  getDailyCost(userId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) as total FROM tasks WHERE user_id = ? AND created_at >= date('now')")
      .get(userId) as { total: number };
    return row.total;
  }

  // --- Conversations ---

  getConversation(userId: string, projectSlug: string, threadId?: string): Conversation | undefined {
    return this.db
      .prepare(
        `SELECT * FROM conversations
         WHERE user_id = ? AND project_slug = ? AND platform_thread_id IS ? AND is_active = 1`,
      )
      .get(userId, projectSlug, threadId ?? null) as Conversation | undefined;
  }

  upsertConversation(conv: Omit<Conversation, "id"> & { id?: string }) {
    const id = conv.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO conversations (id, user_id, project_slug, platform_chat_id, platform_thread_id, claude_session_id, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, project_slug, platform_chat_id, platform_thread_id)
         DO UPDATE SET claude_session_id = excluded.claude_session_id`,
      )
      .run(id, conv.user_id, conv.project_slug, conv.platform_chat_id, conv.platform_thread_id ?? null, conv.claude_session_id ?? null, conv.is_active ? 1 : 0);
  }

  // --- Memory ---

  addMemory(entry: Omit<MemoryEntry, "id" | "created_at"> & { id?: string }): MemoryEntry {
    const id = entry.id ?? randomUUID();
    this.db
      .prepare(
        "INSERT INTO memory_entries (id, project_slug, type, content, source_task_id) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, entry.project_slug, entry.type, entry.content, entry.source_task_id ?? null);
    return { ...entry, id, created_at: new Date().toISOString() } as MemoryEntry;
  }

  getMemoryByProject(projectSlug: string, opts?: { type?: MemoryType; limit?: number }): MemoryEntry[] {
    const type = opts?.type;
    const limit = opts?.limit ?? 30;

    if (type) {
      return this.db
        .prepare("SELECT * FROM memory_entries WHERE project_slug = ? AND type = ? ORDER BY created_at DESC LIMIT ?")
        .all(projectSlug, type, limit) as MemoryEntry[];
    }
    return this.db
      .prepare("SELECT * FROM memory_entries WHERE project_slug = ? ORDER BY created_at DESC LIMIT ?")
      .all(projectSlug, limit) as MemoryEntry[];
  }

  clearMemory(projectSlug: string) {
    this.db.prepare("DELETE FROM memory_entries WHERE project_slug = ?").run(projectSlug);
  }

  // --- Cross-Project Memory ---

  addCrossProjectMemory(entry: Omit<CrossProjectEntry, "id" | "created_at">): CrossProjectEntry {
    const id = randomUUID();
    // Replace existing entry for same source_project + type
    this.db
      .prepare("DELETE FROM cross_project_memory WHERE project_group = ? AND source_project = ? AND type = ?")
      .run(entry.project_group, entry.source_project, entry.type);
    this.db
      .prepare(
        "INSERT INTO cross_project_memory (id, project_group, source_project, type, content) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, entry.project_group, entry.source_project, entry.type, entry.content);
    return { ...entry, id, created_at: new Date().toISOString() };
  }

  getCrossProjectMemory(projectGroup: string): CrossProjectEntry[] {
    return this.db
      .prepare("SELECT * FROM cross_project_memory WHERE project_group = ? ORDER BY created_at DESC")
      .all(projectGroup) as CrossProjectEntry[];
  }

  // --- Audit ---

  logAction(userId: string, action: string, details: string) {
    this.db
      .prepare("INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)")
      .run(userId, action, details);
  }

  close() {
    this.db.close();
  }
}
