import { execa, type ResultPromise } from "execa";
import type { ProjectConfig, PreviewConfig } from "../config/index.js";
import type { Logger } from "pino";

// --- Tunneler Interface ---

export interface Tunnel {
  id: string;
  publicUrl: string;
  provider: string;
  kill: () => void;
}

export interface Tunneler {
  name: string;
  start(port: number): Promise<Tunnel>;
  stop(id: string): void;
}

// --- ngrok ---

export class NgrokTunneler implements Tunneler {
  name = "ngrok";
  private tunnels = new Map<string, Tunnel>();

  constructor(
    private authToken: string,
    private logger: Logger,
  ) {}

  async start(port: number): Promise<Tunnel> {
    const args = ["http", String(port), "--log", "stdout", "--log-format", "json"];
    if (this.authToken) args.push("--authtoken", this.authToken);

    const proc = execa("ngrok", args);
    const url = await this.parseUrl(proc);

    const tunnel: Tunnel = {
      id: crypto.randomUUID(),
      publicUrl: url,
      provider: "ngrok",
      kill: () => proc.kill(),
    };

    this.tunnels.set(tunnel.id, tunnel);
    this.logger.info({ url, port }, "ngrok tunnel ready");
    return tunnel;
  }

  stop(id: string) {
    this.tunnels.get(id)?.kill();
    this.tunnels.delete(id);
  }

  private parseUrl(proc: ResultPromise): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("ngrok timeout")), 30_000);

      proc.stdout?.on("data", (chunk: Buffer) => {
        const line = chunk.toString();
        try {
          const log = JSON.parse(line);
          if (log.url) {
            clearTimeout(timeout);
            resolve(log.url);
          }
        } catch { /* not JSON */ }
      });

      proc.on("exit", () => {
        clearTimeout(timeout);
        reject(new Error("ngrok exited"));
      });
    });
  }
}

// --- cloudflared ---

export class CloudflaredTunneler implements Tunneler {
  name = "cloudflared";
  private tunnels = new Map<string, Tunnel>();

  constructor(private logger: Logger) {}

  async start(port: number): Promise<Tunnel> {
    const proc = execa("cloudflared", ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"]);
    const url = await this.parseUrl(proc);

    const tunnel: Tunnel = {
      id: crypto.randomUUID(),
      publicUrl: url,
      provider: "cloudflared",
      kill: () => proc.kill(),
    };

    this.tunnels.set(tunnel.id, tunnel);
    this.logger.info({ url, port }, "cloudflared tunnel ready");
    return tunnel;
  }

  stop(id: string) {
    this.tunnels.get(id)?.kill();
    this.tunnels.delete(id);
  }

  private parseUrl(proc: ResultPromise): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("cloudflared timeout")), 30_000);
      const pattern = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

      // cloudflared outputs URL on stderr
      proc.stderr?.on("data", (chunk: Buffer) => {
        const match = chunk.toString().match(pattern);
        if (match) {
          clearTimeout(timeout);
          resolve(match[0]);
        }
      });

      proc.on("exit", () => {
        clearTimeout(timeout);
        reject(new Error("cloudflared exited"));
      });
    });
  }
}

// --- Preview Manager ---

export class PreviewManager {
  private activeTunnels = new Map<string, Tunnel>(); // project slug -> tunnel
  private activeProcs = new Map<string, () => void>(); // project slug -> kill fn

  constructor(
    private tunneler: Tunneler,
    private config: PreviewConfig,
    private logger: Logger,
  ) {}

  async deploy(project: ProjectConfig): Promise<string> {
    const slug = project.agent; // using agent as identifier proxy, ideally pass slug
    this.teardown(slug);

    // Build
    if (project.build) {
      this.logger.info({ project: slug, cmd: project.build }, "building");
      await execa("sh", ["-c", project.build], { cwd: project.path });
    }

    // Start dev server
    if (project.dev) {
      const devProc = execa("sh", ["-c", project.dev], { cwd: project.path });
      this.activeProcs.set(slug, () => devProc.kill());

      // Health check
      const port = project.port ?? 8080;
      await this.waitForPort(port, this.config.health_check_timeout_seconds * 1000);
      this.logger.info({ port }, "dev server ready");
    }

    // Tunnel
    const port = project.port ?? 8080;
    const tunnel = await this.tunneler.start(port);
    this.activeTunnels.set(slug, tunnel);

    return tunnel.publicUrl;
  }

  teardown(slug: string) {
    this.activeTunnels.get(slug)?.kill();
    this.activeTunnels.delete(slug);
    this.activeProcs.get(slug)?.();
    this.activeProcs.delete(slug);
  }

  getPreviewUrl(slug: string): string | undefined {
    return this.activeTunnels.get(slug)?.publicUrl;
  }

  private async waitForPort(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`http://localhost:${port}`);
        resp.body?.cancel();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    throw new Error(`Port ${port} not ready after ${timeoutMs}ms`);
  }
}
