/**
 * Real-model smoke for the M0 gate: spawn the actual llama-server with the
 * actual GGUF, wait for health, cancel. Slow (model load ~1 min), so it runs
 * only with TINYTINY_INTEGRATION=1. Defaults to the measured model path;
 * override with TINYTINY_MODEL.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../../src/server/config.ts";
import { LlamaServer, probePort } from "../../src/server/llama-server.ts";

const integration = process.env.TINYTINY_INTEGRATION === "1";

test("real llama-server spawns, becomes healthy, and stops cleanly", { skip: !integration }, async () => {
  const server = new LlamaServer(DEFAULT_CONFIG);
  const startedAt = Date.now();
  await server.start(180_000);
  const loadMs = Date.now() - startedAt;
  assert.equal(server.isRunning, true);
  assert.equal(await probePort(DEFAULT_CONFIG.host, DEFAULT_CONFIG.port), true);
  assert.match(server.logTail(20).join("\n"), /listening on http/);
  console.log(`[integration] ready in ${(loadMs / 1000).toFixed(1)}s`);

  const code = await server.stop();
  assert.ok(code !== null);
  assert.equal(server.isRunning, false);
  console.log(`[integration] stopped, exit code ${code}`);
});
