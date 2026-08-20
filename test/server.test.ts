/**
 * Fast suite for the llama-server wrapper (M0 gate: spawn / health / cancel).
 * Uses the fake-server fixture, never the real model. The real-model smoke
 * lives in test/integration (gated by TINYTINY_INTEGRATION).
 */

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildArgs, DEFAULT_CONFIG, type LlamaServerConfig } from "../src/server/config.ts";
import { LlamaServer, probePort } from "../src/server/llama-server.ts";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-server.mjs");

function cfg(overrides: Partial<LlamaServerConfig> = {}): LlamaServerConfig {
  return { ...DEFAULT_CONFIG, bin: FIXTURE, ...overrides };
}

/** Grab a free ephemeral port, then release it for the child to bind. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr !== null && typeof addr === "object") {
        const port = addr.port;
        s.close(() => resolve(port));
      } else {
        reject(new Error("failed to allocate a free port"));
      }
    });
  });
}

describe("buildArgs", () => {
  test("produces the exact measured flag set", () => {
    const port = 18123;
    assert.deepEqual(buildArgs(cfg({ port })), [
      "-m", DEFAULT_CONFIG.modelPath,
      "-t", "8",
      "--ctx-size", "32768",
      "--cache-type-k", "q8_0",
      "--cache-type-v", "q8_0",
      "--parallel", "1",
      "--reasoning-budget", "512",
      "--reasoning-format", "deepseek",
      "--host", "127.0.0.1",
      "--port", "18123",
      "--jinja",
    ]);
  });
});

describe("probePort", () => {
  test("true when a server listens, false when nothing does", async () => {
    const port = await freePort();
    const s = net.createServer((sock) => sock.end());
    await new Promise<void>((res) => s.listen(port, "127.0.0.1", () => res()));
    assert.equal(await probePort("127.0.0.1", port), true);
    await new Promise<void>((res) => s.close(() => res()));
    assert.equal(await probePort("127.0.0.1", port), false);
  });
});

describe("LlamaServer", () => {
  let savedMode: string | undefined;

  beforeEach(() => {
    savedMode = process.env.FAKE_MODE;
  });

  afterEach(() => {
    if (savedMode === undefined) delete process.env.FAKE_MODE;
    else process.env.FAKE_MODE = savedMode;
  });

  test("start resolves once ready, stop returns exit code and frees the port", async () => {
    const port = await freePort();
    const server = new LlamaServer(cfg({ port }));
    await server.start(5_000);
    assert.equal(server.isRunning, true);
    assert.ok(server.pid !== undefined);
    assert.equal(server.baseUrl, `http://127.0.0.1:${port}`);
    assert.equal(await probePort("127.0.0.1", port), true);
    assert.match(server.logTail(10).join("\n"), /listening on http/);

    const code = await server.stop();
    assert.equal(code, 0);
    assert.equal(server.isRunning, false);
    assert.equal(await probePort("127.0.0.1", port), false);
  });

  test("start rejects on deadline with the captured log tail", async () => {
    process.env.FAKE_MODE = "never";
    const port = await freePort();
    const server = new LlamaServer(cfg({ port }));
    await assert.rejects(
      server.start(1_500),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        return msg.includes("did not become ready") && msg.includes("warming up");
      },
    );
    assert.equal(server.isRunning, false);
  });

  test("start rejects when the process exits before ready", async () => {
    process.env.FAKE_MODE = "fail";
    const port = await freePort();
    const server = new LlamaServer(cfg({ port }));
    await assert.rejects(
      server.start(5_000),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        return msg.includes("exited before ready") && msg.includes("error loading model");
      },
    );
  });

  test("start rejects when the binary cannot be spawned", async () => {
    const server = new LlamaServer(cfg({ bin: "/nonexistent/llama-server" }));
    await assert.rejects(
      server.start(5_000),
      (err: unknown) => err instanceof Error && err.message.includes("failed to spawn"),
    );
  });

  test("stop escalates to SIGKILL when SIGTERM is ignored", async () => {
    process.env.FAKE_MODE = "hang";
    const port = await freePort();
    const server = new LlamaServer(cfg({ port }));
    await server.start(5_000);
    assert.equal(server.isRunning, true);
    const code = await server.stop(500);
    assert.ok(code !== null, "process must exit even when it ignores SIGTERM");
    assert.equal(server.isRunning, false);
    assert.equal(await probePort("127.0.0.1", port), false);
  });
});
