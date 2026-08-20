/**
 * M1 gate: cache warmth on a true extension, against the real llama-server.
 * Turn 1 asks for a tool call; the harness stores assistant + tool result;
 * turn 2 extends the conversation. A warm slot cache must show
 * `cached_tokens > 0` on turn 2.
 *
 * Slow (model load + two generations), so gated by TINYTINY_INTEGRATION=1.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chat } from "../../src/client.ts";
import { MessageStore, type ToolSchema } from "../../src/prompt/messages.ts";
import { buildRequest } from "../../src/prompt/builder.ts";
import { DEFAULT_SESSION_CONFIG } from "../../src/prompt/session.ts";
import { DEFAULT_CONFIG, type LlamaServerConfig } from "../../src/server/config.ts";
import { LlamaServer } from "../../src/server/llama-server.ts";

const integration = process.env.TINYTINY_INTEGRATION === "1";

const READ_TOOL: ToolSchema = {
  type: "function",
  function: {
    name: "read",
    description: "Read a file, optionally a line range.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer" },
        limit: { type: "integer" },
      },
      required: ["path"],
    },
  },
};

test(
  "turn 2 on a true extension shows cached_tokens > 0",
  { skip: !integration },
  async () => {
    const tmp = path.join(os.tmpdir(), `tinytiny-cachewarm-${process.pid}.txt`);
    fs.writeFileSync(tmp, "1\n2\n3\n4\n5\n");

    // Default config now carries --temp 0.3 (measured: tool calls 3/3 with
    // short reasoning, vs 1/3 and degenerate thinking at default 0.8 —
    // LESSONS.md). maxTokens 1024 is a generous guard, never the binding
    // constraint: the model self-terminates at the tool call.
    const cfg: LlamaServerConfig = { ...DEFAULT_CONFIG };
    const server = new LlamaServer(cfg);
    const store = new MessageStore();

    try {
      await server.start(180_000);
      console.log(`[integration] server ready at ${server.baseUrl}`);

      // Turn 1: ask for a tool call with a natural instruction. Adversarial
      // steering ("you MUST call") makes the model over-call tools and
      // hallucinate an agentic trace (LESSONS.md); natural wording +
      // --temp 0.3 measured 3/3 single clean calls.
      store.addUser("Use the read tool on this file and call it now: " + tmp);
      const turn1 = buildRequest(store, DEFAULT_SESSION_CONFIG.systemPrompt);
      const r1 = await chat(server.baseUrl, { messages: turn1, tools: [READ_TOOL], maxTokens: 1024 });
      assert.ok(
        r1.toolCalls.length === 1,
        `expected one tool call, got ${r1.toolCalls.length}; ` +
          `content=${JSON.stringify(r1.content)} ` +
          `reasoning=${JSON.stringify(r1.reasoning.slice(-300))}`,
      );
      assert.ok(r1.toolCalls.length === 1, `expected one tool call, got ${r1.toolCalls.length}`);
      const call = r1.toolCalls[0]!;
      assert.equal(call.function.name, "read");
      store.ingestCompletion({
        role: "assistant",
        content: r1.content,
        tool_calls: r1.toolCalls,
      });
      console.log(`[integration] turn 1: prompt_tokens=${r1.usage?.prompt_tokens} cached=${r1.usage?.prompt_tokens_details?.cached_tokens}`);

      // Tool result (the M2 executor would do this; M1 simulates it).
      store.addTool(call.id, fs.readFileSync(tmp, "utf8"));

      // Turn 2: true extension.
      store.addUser("Now sum those numbers and answer with just the total.");
      const turn2 = buildRequest(store, DEFAULT_SESSION_CONFIG.systemPrompt);
      const r2 = await chat(server.baseUrl, { messages: turn2, tools: [READ_TOOL], maxTokens: 1024 });

      const cached = r2.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      console.log(`[integration] turn 2: prompt_tokens=${r2.usage?.prompt_tokens} cached=${cached} answer=${JSON.stringify(r2.content)}`);
      assert.ok(cached > 0, `expected cached_tokens > 0 on extension, got ${cached}`);
      assert.equal(
        r2.content?.trim(),
        "15",
        `model must answer the sum of 1..5; got ${JSON.stringify(r2.content)} ` +
          `reasoning=${JSON.stringify(r2.reasoning.slice(-200))}`,
      );
    } finally {
      await server.stop();
      fs.rmSync(tmp, { force: true });
    }
  },
);
