/**
 * Chat client tests against the mock completions server: non-stream parse,
 * stream event normalization, abort, HTTP errors, and the wire-level
 * byte-identical re-send invariant across a tool round-trip.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chat, chatStream, accumulate } from "../src/client.ts";
import { MessageStore, type ToolSchema } from "../src/prompt/messages.ts";
import { buildRequest } from "../src/prompt/builder.ts";
import { DEFAULT_SESSION_CONFIG } from "../src/prompt/session.ts";
import { startMockCompletions } from "./helpers/mock-server.ts";

const TOOL_SCHEMA: ToolSchema = {
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

const SYSTEM = DEFAULT_SESSION_CONFIG.systemPrompt;

describe("chat (non-streaming)", () => {
  test("parses tool_calls, reasoning, usage, finish_reason; sends tools and stream:false", async () => {
    const toolCall = {
      id: "call_1",
      type: "function",
      function: { name: "read", arguments: '{"path":"/tmp/foo.txt"}' },
    };
    const mock = await startMockCompletions(() => ({
      json: {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [toolCall],
              reasoning_content: "User wants the file read.",
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {
          prompt_tokens: 300,
          completion_tokens: 40,
          total_tokens: 340,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      },
    }));

    try {
      const result = await chat(mock.url, {
        messages: [{ role: "user", content: "hi" }],
        tools: [TOOL_SCHEMA],
      });

      assert.deepEqual(result.toolCalls, [toolCall]);
      assert.equal(result.reasoning, "User wants the file read.");
      assert.equal(result.finishReason, "tool_calls");
      assert.equal(result.usage?.prompt_tokens_details?.cached_tokens, 0);

      const body = mock.bodies[0]!;
      assert.equal(body.stream, false);
      assert.deepEqual(body.tools, [TOOL_SCHEMA]);
      assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
    } finally {
      await mock.close();
    }
  });

  test("throws on HTTP error with status in the message", async () => {
    const mock = await startMockCompletions(() => ({ status: 500, json: { error: "boom" } }));
    try {
      await assert.rejects(
        chat(mock.url, { messages: [{ role: "user", content: "x" }] }),
        /HTTP 500/,
      );
    } finally {
      await mock.close();
    }
  });

  test("aborts the request when the signal fires", async () => {
    const mock = await startMockCompletions(() => ({
      status: 200,
      delayMs: 200,
      json: { choices: [{ message: { role: "assistant", content: "late" }, finish_reason: "stop" }] },
    }));
    try {
      const ac = new AbortController();
      const promise = chat(mock.url, {
        messages: [{ role: "user", content: "x" }],
        signal: ac.signal,
      });
      ac.abort();
      await assert.rejects(promise);
    } finally {
      await mock.close();
    }
  });
});

describe("chatStream", () => {
  test("normalizes reasoning, content, tool_call fragments, and finish", async () => {
    const frames = [
      { delta: { reasoning_content: "Think" }, finish_reason: null },
      { delta: { reasoning_content: "ing" }, finish_reason: null },
      { delta: { content: "Using " }, finish_reason: null },
      { delta: { content: "read" }, finish_reason: null },
      {
        delta: {
          tool_calls: [{ index: 0, id: "call_9", function: { name: "re", arguments: '{"path"' } }],
        },
        finish_reason: null,
      },
      {
        delta: {
          tool_calls: [{ index: 0, function: { name: "ad", arguments: ':"/tmp/foo.txt"}' } }],
        },
        finish_reason: null,
      },
      { delta: {}, finish_reason: "tool_calls" },
    ].map((c) => `data: ${JSON.stringify({ choices: [c] })}\n\n`);
    const mock = await startMockCompletions(() => ({ sse: frames }));

    try {
      const events = [];
      for await (const ev of chatStream(mock.url, {
        messages: [{ role: "user", content: "read it" }],
        tools: [TOOL_SCHEMA],
      })) {
        events.push(ev);
      }

      assert.deepEqual(events.filter((e) => e.kind === "reasoning"), [
        { kind: "reasoning", text: "Think" },
        { kind: "reasoning", text: "ing" },
      ]);
      assert.deepEqual(events.filter((e) => e.kind === "content"), [
        { kind: "content", text: "Using " },
        { kind: "content", text: "read" },
      ]);

      const result = await accumulate(chatStream(mock.url, {
        messages: [{ role: "user", content: "read it" }],
      }));
      assert.equal(result.reasoning, "Thinking");
      assert.equal(result.content, "Using read");
      assert.equal(result.finishReason, "tool_calls");
      assert.equal(result.toolCalls.length, 1);
      assert.equal(result.toolCalls[0]?.function.name, "read");
      assert.equal(result.toolCalls[0]?.function.arguments, '{"path":"/tmp/foo.txt"}');
      assert.equal(result.toolCalls[0]?.id, "call_9");

      const body = mock.bodies[0]!;
      assert.equal(body.stream, true);
      assert.deepEqual(body.tools, [TOOL_SCHEMA]);
    } finally {
      await mock.close();
    }
  });
});

describe("wire-level strict extension", () => {
  test("turn 2 re-sends the turn 1 message prefix byte-identical through a tool round-trip", async () => {
    const toolCall = {
      id: "call_42",
      type: "function",
      function: { name: "read", arguments: '{"path":"/tmp/foo.txt"}' },
    };
    const mock = await startMockCompletions((_body, count) => {
      if (count === 1) {
        return {
          json: {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [toolCall],
                  reasoning_content: "Use the tool.",
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          },
        };
      }
      return {
        json: {
          choices: [{ message: { role: "assistant", content: "15", finish_reason: "stop" } }],
          usage: {
            prompt_tokens: 180,
            completion_tokens: 5,
            total_tokens: 185,
            prompt_tokens_details: { cached_tokens: 100 },
          },
        },
      };
    });

    const store = new MessageStore();

    try {
      // Turn 1: user asks, model emits a tool call.
      store.addUser("Read /tmp/foo.txt using the tool.");
      const turn1 = buildRequest(store, SYSTEM);
      const r1 = await chat(mock.url, { messages: turn1, tools: [TOOL_SCHEMA] });
      store.ingestCompletion({
        role: "assistant",
        content: r1.content,
        tool_calls: r1.toolCalls,
      });
      store.addTool(r1.toolCalls[0]!.id, "1\n2\n3");

      // Turn 2: strict extension.
      store.addUser("Now what is the sum?");
      const turn2 = buildRequest(store, SYSTEM);
      const r2 = await chat(mock.url, { messages: turn2, tools: [TOOL_SCHEMA] });
      assert.equal(r2.content, "15");
      assert.equal(r2.usage?.prompt_tokens_details?.cached_tokens, 100);

      // The prefix of turn 2's messages must serialize byte-identically to
      // turn 1's full message array (key order included).
      const turn2Messages = mock.bodies[1]!.messages as unknown[];
      const turn1Messages = mock.bodies[0]!.messages as unknown[];
      const prefix = turn2Messages.slice(0, turn1Messages.length);
      assert.equal(JSON.stringify(prefix), JSON.stringify(turn1Messages));
      // And turn 2 sends exactly three more messages: assistant call, tool
      // result, and the new user turn.
      assert.equal(turn2Messages.length, turn1Messages.length + 3);
    } finally {
      await mock.close();
    }
  });
});
