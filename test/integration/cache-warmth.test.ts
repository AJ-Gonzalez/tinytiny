/**
 * M1 gate: cache warmth on a true extension, against the real llama-server.
 * Turn 1 asks for a tool call; the harness stores assistant + tool result;
 * turn 2 extends the conversation. A warm slot cache must show
 * `cached_tokens > 0` on turn 2.
 *
 * Slow (model load + two generations), so gated by TINYTINY_INTEGRATION=1.
 *
 * Retry-with-steering: on this llama.cpp build (10154) the model occasionally
 * skips the tool call or emits native `<invoke>` XML as the `arguments`
 * string, which the server rejects with HTTP 500. A failed attempt never
 * mutates the store (ingest happens only on success), so steering appends a
 * concrete correction to history and resends — still a byte-identical
 * extension, which is what cache warmth needs. This is a preview of the M3
 * loop's retry path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chat, type ChatResult } from "../../src/client.ts";
import { MessageStore, type ToolSchema } from "../../src/prompt/messages.ts";
import { buildRequest } from "../../src/prompt/builder.ts";
import { DEFAULT_SESSION_CONFIG, taskBrief } from "../../src/prompt/session.ts";
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

/** Steering copy for a degenerate tool-call turn (see module comment). */
const STEER = [
  "That reply was not usable.",
  "Emit exactly one tool call to `read` whose `arguments` is a valid JSON",
  "object, e.g. {\"path\": \"/abs/file.txt\"}. No prose, no XML.",
].join(" ");

/**
 * Send the stored history, demanding a single `read` tool call. On a skipped
 * call or a server 500 (bad args), append `STEER` to the store and retry.
 * Only a valid single-call response resolves.
 */
async function callRead(
  baseUrl: string,
  store: MessageStore,
  label: string,
): Promise<ChatResult> {
  let lastErr = "no attempt";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await chat(baseUrl, {
        messages: buildRequest(store),
        tools: [READ_TOOL],
        maxTokens: 1024,
      });
      const ok = res.toolCalls.length === 1 && res.toolCalls[0]!.function.name === "read";
      if (ok) return res;
      lastErr =
        `no valid call (got ${res.toolCalls.length}); ` +
        `content=${JSON.stringify((res.content ?? "").slice(0, 120))} ` +
        `reasoning=${JSON.stringify(res.reasoning.slice(-120))}`;
    } catch (e) {
      lastErr = String((e as Error).message).slice(0, 200);
    }
    console.log(`[integration] ${label} attempt ${attempt} failed (${lastErr}); steering…`);
    store.addUser(STEER);
  }
  throw new Error(`${label} failed after 3 attempts: ${lastErr}`);
}

test(
  "turn 2 on a true extension shows cached_tokens > 0",
  { skip: !integration },
  async () => {
    const tmp = path.join(os.tmpdir(), `tinytiny-cachewarm-${process.pid}.txt`);
    const tmp2 = path.join(os.tmpdir(), `tinytiny-cachewarm-${process.pid}-b.txt`);
    fs.writeFileSync(tmp, "1\n2\n3\n4\n5\n");
    fs.writeFileSync(tmp2, "6\n7\n8\n9\n10\n");

    // Default config carries --temp 0.3 (LESSONS.md); maxTokens 1024 is a
    // generous guard, never the binding constraint.
    const cfg: LlamaServerConfig = { ...DEFAULT_CONFIG };
    const server = new LlamaServer(cfg);
    const store = new MessageStore();

    try {
      await server.start(180_000);
      console.log(`[integration] server ready at ${server.baseUrl}`);

      // Turn 1: contract + task in the FIRST user message (no system role —
      // a system message breaks tool calling on this arch, LESSONS.md).
      store.addUser(taskBrief(
        DEFAULT_SESSION_CONFIG.contract,
        "Use the read tool on this file and call it now: " + tmp,
      ));
      const r1 = await callRead(server.baseUrl, store, "turn1");
      const call = r1.toolCalls[0]!;
      store.ingestCompletion({
        role: "assistant",
        content: r1.content,
        tool_calls: r1.toolCalls,
      });
      console.log(`[integration] turn 1: prompt_tokens=${r1.usage?.prompt_tokens} cached=${r1.usage?.prompt_tokens_details?.cached_tokens}`);

      // Tool result (the M2 executor would do this; M1 simulates it).
      store.addTool(call.id, fs.readFileSync(tmp, "utf8"));

      // Turn 2: true extension — a second tool call on a fresh file. The
      // prompt prefix from turn 1 is unchanged, so a warm slot cache must
      // show cached_tokens > 0.
      store.addUser("Use the read tool on this file and call it now: " + tmp2);
      const r2 = await callRead(server.baseUrl, store, "turn2");

      const cached = r2.usage?.prompt_tokens_details?.cached_tokens ?? 0;
      console.log(`[integration] turn 2: prompt_tokens=${r2.usage?.prompt_tokens} cached=${cached} answer=${JSON.stringify(r2.content)}`);
      assert.ok(cached > 0, `expected cached_tokens > 0 on extension, got ${cached}`);
      assert.equal(r2.toolCalls.length, 1, `expected one tool call, got ${r2.toolCalls.length}`);
      assert.equal(r2.toolCalls[0]!.function.name, "read");
    } finally {
      await server.stop();
      fs.rmSync(tmp, { force: true });
      fs.rmSync(tmp2, { force: true });
    }
  },
);
