/**
 * MessageStore + prompt builder unit tests: think-strip, verbatim tool_calls,
 * append-only history, strict-extension builder shape.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MessageStore } from "../src/prompt/messages.ts";
import { buildRequest } from "../src/prompt/builder.ts";
import { DEFAULT_SESSION_CONFIG } from "../src/prompt/session.ts";

const TOOL_CALL = {
  id: "call_abc123",
  type: "function",
  function: { name: "read", arguments: '{"path":"/tmp/foo.txt","limit":5}' },
} as const;

describe("MessageStore", () => {
  test("ingest drops reasoning_content, keeps content and tool_calls verbatim", () => {
    const store = new MessageStore();
    store.ingestCompletion({
      role: "assistant",
      content: null,
      tool_calls: [TOOL_CALL],
      reasoning_content: "I should read the file first.",
    });

    assert.equal(store.length, 1);
    const msg = store.messages[0];
    assert.ok(msg !== undefined && msg.role === "assistant");
    assert.equal(msg.content, null);
    assert.deepEqual(msg.tool_calls, [TOOL_CALL]);
    assert.ok(!("reasoning_content" in msg), "reasoning must never be stored");
  });

  test("assistant content-only turns store content with no tool_calls key", () => {
    const store = new MessageStore();
    store.ingestCompletion({ role: "assistant", content: "The total is 15." });
    const msg = store.messages[0];
    assert.ok(msg !== undefined && msg.role === "assistant");
    assert.equal(msg.content, "The total is 15.");
    assert.equal("tool_calls" in msg, false);
  });

  test("addTool appends a tool message bound to the call id", () => {
    const store = new MessageStore();
    store.addAssistant(null, [TOOL_CALL]);
    store.addTool("call_abc123", "1\n2\n3");
    assert.equal(store.length, 2);
    const tool = store.messages[1];
    assert.ok(tool !== undefined && tool.role === "tool");
    assert.equal(tool.tool_call_id, "call_abc123");
    assert.equal(tool.content, "1\n2\n3");
  });
});

describe("buildRequest", () => {
  test("prepends system and sends the stored history unchanged", () => {
    const store = new MessageStore();
    store.addUser("first turn");
    const req = buildRequest(store, DEFAULT_SESSION_CONFIG.systemPrompt);

    assert.equal(req.length, store.length + 1); // + system
    assert.equal(req[0]?.role, "system");
    assert.equal(req[0]?.content, DEFAULT_SESSION_CONFIG.systemPrompt);
    assert.deepEqual(req[1], { role: "user", content: "first turn" });
  });

  test("reuses stored objects by reference (no re-serialization)", () => {
    const store = new MessageStore();
    store.addUser("first turn");
    const req = buildRequest(store, DEFAULT_SESSION_CONFIG.systemPrompt);
    assert.equal(req[1], store.messages[0], "stored object must be re-sent as-is");
  });

  test("store is unchanged by building (append-only)", () => {
    const store = new MessageStore();
    store.addUser("a");
    const before = store.length;
    buildRequest(store, DEFAULT_SESSION_CONFIG.systemPrompt);
    assert.equal(store.length, before);
  });

  test("every build is a strict extension of the previous", () => {
    const store = new MessageStore();
    store.addUser("turn one");
    const req1 = buildRequest(store, DEFAULT_SESSION_CONFIG.systemPrompt);
    store.addUser("turn two");
    const req2 = buildRequest(store, DEFAULT_SESSION_CONFIG.systemPrompt);

    assert.equal(req1.length, 2);
    assert.equal(req2.length, 3);
    // Turn 2's first 2 messages serialize byte-identical to turn 1's full set.
    assert.equal(JSON.stringify(req2.slice(0, req1.length)), JSON.stringify(req1));
  });
});
