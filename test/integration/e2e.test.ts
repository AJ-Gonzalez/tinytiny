/**
 * M3 exit gate: an end-to-end task against the REAL model.
 *
 * Toy task in the repo's scratch dir (.tinytiny-e2e/, gitignored): the agent
 * must write a small JS file and run it, verifying the output. This exercises
 * the full loop — tool calls, results, retry-with-steering, budget telemetry
 * — against the actual model (language-agnostic harness: the task is "write
 * code and run it", not harness-specific).
 *
 * Slow (model load + several turns at ~1 t/s), so gated by
 * TINYTINY_INTEGRATION=1.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AgentLoop } from "../../src/loop/agent.ts";
import { DEFAULT_CONFIG } from "../../src/server/config.ts";
import { LlamaServer } from "../../src/server/llama-server.ts";

const integration = process.env.TINYTINY_INTEGRATION === "1";

const SCRATCH = path.join(process.cwd(), ".tinytiny-e2e");

test(
  "end-to-end: agent writes code and runs it against the real model",
  { skip: !integration, timeout: 3_600_000 },
  async () => {
    fs.mkdirSync(SCRATCH, { recursive: true });

    const cfg = { ...DEFAULT_CONFIG };
    const server = new LlamaServer(cfg);
    const target = path.join(".tinytiny-e2e", "compute.js");

    try {
      await server.start(180_000);
      console.log(`[e2e] server ready at ${server.baseUrl}`);

      const loop = new AgentLoop({
        baseUrl: server.baseUrl,
        task:
          "Write a JavaScript file at " + target +
          " that computes the sum of 1 through 10 and prints it with console.log. " +
          "Then run it with `node` using the bash tool and confirm it prints 55.",
        maxSteps: 25,
      });

      const result = await loop.run();
      console.log(`[e2e] answer=${JSON.stringify(result.answer)}`);
      console.log(`[e2e] telemetry=${JSON.stringify(result.telemetry)}`);

      // The agent must have written the file and it must produce 55 when run.
      assert.ok(fs.existsSync(target), "agent wrote the target file");
      const out = require("node:child_process").execFileSync("node", [target], { encoding: "utf8" });
      assert.match(out.trim(), /55/, `running the file must print 55; got ${JSON.stringify(out)}`);

      // Budget telemetry present.
      assert.ok(result.telemetry.steps >= 2, `expected >= 2 turns, got ${result.telemetry.steps}`);
      assert.ok(result.telemetry.totalPromptTokens > 0, "prompt token telemetry present");
      assert.ok(result.telemetry.totalCompletionTokens > 0, "completion token telemetry present");
    } finally {
      await server.stop();
      fs.rmSync(SCRATCH, { recursive: true, force: true });
    }
  },
);
