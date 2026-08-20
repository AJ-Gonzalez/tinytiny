/**
 * llama-server child-process wrapper: spawn, readiness, graceful stop,
 * stderr capture. The harness never runs the engine in-process (D2).
 */

import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { buildArgs, type LlamaServerConfig } from "./config.ts";

const READY_LOG = /listening on http/i;
const LOG_LIMIT = 200;

/** True if `host:port` accepts a TCP connection within `timeoutMs`. */
export function probePort(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    const t = setTimeout(() => done(false), timeoutMs);
    t.unref();
  });
}

export class LlamaServer {
  private readonly cfg: LlamaServerConfig;
  private readonly bin: string;
  private proc: ChildProcess | undefined;
  private log: string[] = [];

  constructor(cfg: LlamaServerConfig, bin: string = cfg.bin) {
    this.cfg = cfg;
    this.bin = bin;
  }

  get baseUrl(): string {
    return `http://${this.cfg.host}:${this.cfg.port}`;
  }

  get isRunning(): boolean {
    return this.proc !== undefined && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Last `n` captured log lines (stdout+stderr, interleaved). */
  logTail(n: number): string[] {
    return this.log.slice(-n);
  }

  /**
   * Spawn llama-server and wait until it is ready: the ready log line
   * AND the HTTP port accepting connections. Rejects on early exit,
   * spawn failure, or deadline — with the log tail in the message.
   */
  start(timeoutMs = 120_000): Promise<void> {
    if (this.isRunning) return Promise.reject(new Error("llama-server already running"));
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, buildArgs(this.cfg), {
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.proc = child;

      let settled = false;
      let logSeen = false;

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(deadline);
        const child = this.proc;
        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
          // Never leak a half-started engine: SIGKILL, then reject once it is gone.
          child.kill("SIGKILL");
          child.once("exit", () => reject(err));
          return;
        }
        reject(err);
      };
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(deadline);
        resolve();
      };

      const onData = (chunk: Buffer): void => {
        for (const line of chunk.toString().split("\n")) {
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            this.log.push(trimmed);
            if (this.log.length > LOG_LIMIT) this.log.shift();
          }
          if (!logSeen && READY_LOG.test(trimmed)) logSeen = true;
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);

      child.once("error", (err) => {
        fail(new Error(`failed to spawn ${this.bin}: ${err.message}\n${this.logTail(20).join("\n")}`));
      });
      child.once("exit", (code, signal) => {
        if (!settled) {
          fail(new Error(
            `llama-server exited before ready (code=${code ?? "null"} signal=${signal ?? "null"})\n` +
            `${this.logTail(30).join("\n")}`,
          ));
        }
      });

      // Poll both readiness conditions until the deadline.
      const pollTimer = setInterval(() => {
        if (settled) return;
        if (!logSeen) return;
        void probePort(this.cfg.host, this.cfg.port, 1500).then((ok) => {
          if (ok) succeed();
        });
      }, 500);
      pollTimer.unref();

      const deadline = setTimeout(() => {
        fail(new Error(
          `llama-server did not become ready within ${timeoutMs}ms; log tail:\n` +
          `${this.logTail(30).join("\n")}`,
        ));
      }, timeoutMs);
      deadline.unref();
    });
  }

  /**
   * Stop the server: SIGTERM, escalate to SIGKILL after `timeoutMs`.
   * Returns the exit code, or null if it was already gone.
   */
  stop(timeoutMs = 10_000): Promise<number | null> {
    const child = this.proc;
    if (child === undefined) return Promise.resolve(null);
    if (child.exitCode !== null || child.signalCode !== null) {
      this.proc = undefined;
      return Promise.resolve(child.exitCode ?? -1);
    }

    const exited = new Promise<number>((res) => {
      child.once("exit", (code) => res(code ?? -1));
    });

    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (this.proc?.exitCode === null && this.proc.signalCode === null) {
        this.proc?.kill("SIGKILL");
      }
    }, timeoutMs);
    timer.unref();

    return exited.then((code) => {
      this.proc = undefined;
      return code;
    });
  }
}
