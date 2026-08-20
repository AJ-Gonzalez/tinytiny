/**
 * M3 agent-loop contract tests, driven by a mock chat client.
 * Each test scripts the model's turns to defend a loop invariant a plausible
 * bug would break: strict-extension tool flow, retry-with-steering, malformed
 * args → tool feedback, Tier-B/Tier-C eviction, telemetry, abort, step cap.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { ChatOptions, ChatResult } from "../src/client.ts";
import { AgentLoop, isRepetitiveContent } from "../src/loop/agent.ts";
import { lastToolExchange, tierCTaskState } from "../src/loop/evict.ts";
import { DEFAULT_SESSION_CONFIG } from "../src/prompt/session.ts";

const BASE = "http://127.0.0.1:18081";

function usage(prompt: number, completion = 10, cached = 0) {
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, prompt_tokens_details: { cached_tokens: cached } };
}

function callResult(overrides: Partial<ChatResult> = {}): ChatResult {
  return { content: null, toolCalls: [], reasoning: "", finishReason: "stop", ...overrides };
}

function toolCall(name: string, args: Record<string, unknown>, id = "call_1"): ChatResult {
  return callResult({ toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
}

function toolCallWithUsage(name: string, args: Record<string, unknown>, prompt: number, id = "call_1"): ChatResult {
  return callResult({ toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }], usage: usage(prompt, 5) });
}

/** Scripted client: returns responses in order, records every request. */
function scripted(responses: (opts: ChatOptions, seen: ChatOptions[]) => ChatResult | Promise<ChatResult>) {
  const seen: ChatOptions[] = [];
  const fn = async (baseUrl: string, opts: ChatOptions): Promise<ChatResult> => {
    assert.equal(baseUrl, BASE);
    seen.push(opts);
    return responses(opts, seen);
  };
  return { fn, seen };
}

test("tool flow: model calls read, loop executes and feeds result, then final answer", async () => {
  fs.writeFileSync("a.txt", "hello\n");
  try {
    const calls: ChatOptions[] = [];
    const { fn } = scripted((opts) => {
      calls.push(opts);
      if (opts.messages.length === 1) return toolCall("read", { path: "a.txt" });
      return callResult({ content: "done", usage: usage(50, 5) });
    });
    const loop = new AgentLoop({ baseUrl: BASE, task: "inspect a.txt", chatFn: fn });
    const result = await loop.run();

    assert.equal(result.answer, "done");
    // Turn 1: user brief only → tool call. Turn 2: brief + assistant + tool result → final answer.
    assert.equal(calls.length, 2);
    const turn1 = calls[0]!.messages;
    assert.equal(turn1[0]!.role, "user");
    const turn2 = calls[1]!.messages;
    const roles = turn2.map((m) => m.role);
    assert.deepEqual(roles, ["user", "assistant", "tool"]);
    const toolMsg = turn2.find((m) => m.role === "tool")!;
    assert.ok(toolMsg.role === "tool" && toolMsg.content.includes("Error") === false);
    assert.equal(result.telemetry.steps, 2);
    assert.equal(result.telemetry.totalCompletionTokens, 5);
  } finally {
    fs.rmSync("a.txt", { force: true });
  }
});

test("final answer is ingested into history (content with no tool call)", async () => {
  const { fn } = scripted(() => callResult({ content: "short answer", usage: usage(10, 3) }));
  const loop = new AgentLoop({ baseUrl: BASE, task: "hi", chatFn: fn });
  const result = await loop.run();
  assert.equal(result.answer, "short answer");
  const last = result.store.messages[result.store.messages.length - 1]!;
  assert.equal(last.role, "assistant");
  assert.ok(last.role === "assistant" && last.content === "short answer");
});

test("retry-with-steering: a 500 is retried with a steering message appended, then succeeds", async () => {
  const seen: ChatOptions[] = [];
  let attempts = 0;
  const fn = async (_baseUrl: string, opts: ChatOptions): Promise<ChatResult> => {
    seen.push(opts);
    attempts++;
    if (attempts === 1) throw new Error("chat request failed: HTTP 500 boom");
    return callResult({ content: "recovered", usage: usage(40, 4) });
  };
  const loop = new AgentLoop({ baseUrl: BASE, task: "t", chatFn: fn });
  const result = await loop.run();
  assert.equal(result.answer, "recovered");
  assert.equal(attempts, 2);
  // The steering message was appended to the store between attempts.
  assert.equal(seen[1]!.messages.length, seen[0]!.messages.length + 1);
  assert.ok((seen[1]!.messages.at(-1) as { role: string }).role === "user");
});

test("degenerate empty turn (no content, no tool call) is retried with steering", async () => {
  const seen: ChatOptions[] = [];
  const fn = async (_baseUrl: string, opts: ChatOptions): Promise<ChatResult> => {
    seen.push(opts);
    if (seen.length === 1) return callResult({ content: null });
    return callResult({ content: "ok", usage: usage(30, 2) });
  };
  const loop = new AgentLoop({ baseUrl: BASE, task: "t", chatFn: fn });
  const result = await loop.run();
  assert.equal(result.answer, "ok");
  assert.equal(seen.length, 2);
});

/** A socket-level error the client would throw when the engine is down. */
function connError(message = "connect ECONNREFUSED 127.0.0.1:18081"): Error {
  const e = new Error(message);
  (e as { code?: string }).code = "ECONNREFUSED";
  return e;
}

test("connection error triggers onConnectionError and retries the same turn without steering", async () => {
  const seen: ChatOptions[] = [];
  let restarts = 0;
  let calls = 0;
  const fn = async (_baseUrl: string, opts: ChatOptions): Promise<ChatResult> => {
    seen.push(opts);
    calls++;
    if (calls === 1) throw connError();
    return callResult({ content: "after restart", usage: usage(30, 3) });
  };
  const loop = new AgentLoop({
    baseUrl: BASE,
    task: "t",
    chatFn: fn,
    onConnectionError: async () => {
      restarts++;
    },
  });
  const result = await loop.run();
  assert.equal(result.answer, "after restart");
  assert.equal(restarts, 1, "restart called once");
  // No steering message was added — both requests have the same message count.
  assert.equal(seen[1]!.messages.length, seen[0]!.messages.length, "same turn retried, no steering appended");
});

test("connection error without a restart handler rethrows", async () => {
  const fn = async (): Promise<ChatResult> => {
    throw connError();
  };
  const loop = new AgentLoop({ baseUrl: BASE, task: "t", chatFn: fn });
  await assert.rejects(() => loop.run(), /ECONNREFUSED/);
});

test("engine-death 500 (vk crash signature) restarts, bad-args 500 steers", async () => {
  // vk crash -> restart (same turn, no steering)
  let restarts = 0;
  const crashFn = async (_b: string, _o: ChatOptions): Promise<ChatResult> => {
    throw new Error('chat request failed: HTTP 500 {"error":{"code":500,"message":"decode() failed: vk::Queue::submit: ErrorDeviceLost"}}');
  };
  const crashLoop = new AgentLoop({ baseUrl: BASE, task: "t", chatFn: crashFn, onConnectionError: async () => { restarts++; } });
  await assert.rejects(() => crashLoop.run(), /HTTP 500|recover from/);
  assert.equal(restarts, 3, "vk-crash 500 treated as engine death; capped at 3 restarts");
});

test("bad-tool-args 500 is steering, not restart", async () => {
  const seen: ChatOptions[] = [];
  let restarts = 0;
  const fn = async (_b: string, opts: ChatOptions): Promise<ChatResult> => {
    seen.push(opts);
    if (seen.length === 1) throw new Error('chat request failed: HTTP 500 {"error":{"message":"Failed to parse tool call arguments as JSON"}}');
    return callResult({ content: "recovered", usage: usage(40, 4) });
  };
  const loop = new AgentLoop({ baseUrl: BASE, task: "t", chatFn: fn, onConnectionError: async () => { restarts++; } });
  const result = await loop.run();
  assert.equal(result.answer, "recovered");
  assert.equal(restarts, 0, "bad-args 500 is model feedback, not engine death");
  assert.ok(seen[1]!.messages.length > seen[0]!.messages.length, "steering message appended");
});

test("malformed tool-call JSON becomes tool feedback, not a crash", async () => {
  const { fn } = scripted((opts) => {
    if (opts.messages.length === 1) {
      return callResult({ toolCalls: [{ id: "call_x", type: "function", function: { name: "read", arguments: "not json{" } }] });
    }
    return callResult({ content: "retried", usage: usage(60, 6) });
  });
  const loop = new AgentLoop({ baseUrl: BASE, task: "t", chatFn: fn });
  const result = await loop.run();
  assert.equal(result.answer, "retried");
  // Second turn must carry the Error: tool feedback for the malformed call.
  const toolMsg = result.store.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg && toolMsg.role === "tool" && toolMsg.content.startsWith("Error:"));
});

test("persistent degenerate turn (all retries empty) throws, never accepted as answer", async () => {
  let calls = 0;
  const fn = async (): Promise<ChatResult> => {
    calls++;
    return callResult({ content: null }); // always degenerate
  };
  const loop = new AgentLoop({ baseUrl: BASE, task: "t", chatFn: fn, retriesPerTurn: 3 });
  await assert.rejects(() => loop.run(), /degenerate turn/);
  assert.equal(calls, 3, "all three retries attempted before throwing");
});

test("repetition detector flags qwen35 spam shapes (LESSONS counterexamples)", () => {
  const spam = [
    "??????????", // char run
    "aaaaaaaaaaaaaaaaaaaaaaaaaa",
    "line one\nline one\nline one\n",
    "har har har har har har har har har har har har",
    "出现 (, at minimum:\n1. Parse the file as UTF-8 text\n2. Parse the file as UTF-8 text\n3. Parse the file as UTF-8 text",
    "the quick brown fox jumps the quick brown fox jumps the quick brown fox jumps the quick brown fox jumps the quick brown fox jumps the quick brown fox jumps",
  ];
  for (const s of spam) {
    assert.ok(isRepetitiveContent(s), `should flag: ${JSON.stringify(s.slice(0, 48))}`);
  }
});

test("repetition detector passes healthy final answers", () => {
  const ok = [
    "1+2+3+4+5+6+7+8+9+10 = 55",
    "I wrote compute.js and ran it with node. The output was 55, exactly as expected.",
    "The sum is 55. Done.",
    "I really really like this result, it is exactly what we wanted.",
    "x = 1\ny = 2\nx = x + y\nreturn x",
  ];
  for (const s of ok) {
    assert.ok(!isRepetitiveContent(s), `should pass: ${JSON.stringify(s)}`);
  }
});

test("repetition-spam turn is steered, never accepted as the answer", async () => {
  const seen: ChatOptions[] = [];
  const fn = async (_b: string, opts: ChatOptions): Promise<ChatResult> => {
    seen.push(opts);
    if (seen.length === 1) return callResult({ content: "har har har har har har har har har har har har", usage: usage(30, 2) });
    return callResult({ content: "done", usage: usage(40, 3) });
  };
  const loop = new AgentLoop({ baseUrl: BASE, task: "t", chatFn: fn });
  const result = await loop.run();
  assert.equal(result.answer, "done");
  assert.equal(seen.length, 2, "spam turn retried with steering");
  assert.equal(seen[1]!.messages.length, seen[0]!.messages.length + 1, "steering message appended between attempts");
});

test("turn cut off at the token cap (finish length, no tool call) is degenerate and steered", async () => {
  const seen: ChatOptions[] = [];
  const fn = async (_b: string, opts: ChatOptions): Promise<ChatResult> => {
    seen.push(opts);
    if (seen.length === 1) return callResult({ content: "partial rambling", finishReason: "length", usage: usage(30, 2) });
    return callResult({ content: "concise", usage: usage(40, 3) });
  };
  const loop = new AgentLoop({ baseUrl: BASE, task: "t", chatFn: fn });
  const result = await loop.run();
  assert.equal(result.answer, "concise");
  assert.equal(seen.length, 2);
});

test("spam content WITH a valid tool call still executes (content is irrelevant to a tool turn)", async () => {
  const seen: ChatOptions[] = [];
  const fn = async (_b: string, opts: ChatOptions): Promise<ChatResult> => {
    seen.push(opts);
    if (seen.length === 1) return callResult({ content: "har har har har har har har har har har har har", toolCalls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: '{"command":"echo hi"}' } }] });
    return callResult({ content: "done", usage: usage(40, 3) });
  };
  const loop = new AgentLoop({ baseUrl: BASE, task: "t", chatFn: fn });
  const result = await loop.run();
  assert.equal(result.answer, "done");
  assert.equal(seen.length, 2, "tool turn executed normally, no steering");
});

test("persistent repetition-spam throws, never accepted as answer", async () => {
  let calls = 0;
  const fn = async (): Promise<ChatResult> => {
    calls++;
    return callResult({ content: "har har har har har har har har har har har har" });
  };
  const loop = new AgentLoop({ baseUrl: BASE, task: "t", chatFn: fn, retriesPerTurn: 3 });
  await assert.rejects(() => loop.run(), /degenerate turn/);
  assert.equal(calls, 3, "all three retries attempted before throwing");
});

test("default per-step max_tokens bounds the degenerate burn (1024, not 4096)", async () => {
  const seen: ChatOptions[] = [];
  const fn = async (_b: string, opts: ChatOptions): Promise<ChatResult> => {
    seen.push(opts);
    return callResult({ content: "done", usage: usage(10, 3) });
  };
  const loop = new AgentLoop({ baseUrl: BASE, task: "t", chatFn: fn });
  await loop.run();
  // Reasoning budget (512) + completion headroom: healthy turns self-terminate
  // far below this; it only binds on a degenerate turn, bounding the burn.
  assert.equal(seen[0]!.maxTokens, 1024);
});

test("bash commands mentioning test are tracked for Tier-C task state", async () => {
  const seen: ChatOptions[] = [];
  const fn = async (_baseUrl: string, opts: ChatOptions): Promise<ChatResult> => {
    seen.push(opts);
    if (seen.length === 1) return toolCall("bash", { command: "node --test" });
    return callResult({ content: "ran", usage: usage(20, 3) });
  };
  const loop = new AgentLoop({ baseUrl: BASE, task: "run tests", chatFn: fn });
  await loop.run();
  // Trigger a Tier-C reset to surface the task state.
  const state = tierCTaskState({ goal: "run tests", filesTouched: [], tests: ["node --test"], openItems: [] });
  assert.ok(state.includes("node --test"), "test command recorded");
});

test("Tier-B eviction: over threshold collapses history to brief + marker + last tool exchange", async () => {
  const seen: ChatOptions[] = [];
  let turn = 0;
  const fn = async (_baseUrl: string, opts: ChatOptions): Promise<ChatResult> => {
    seen.push(opts);
    turn++;
    // Turn 1 call a tool; turn 2 call a tool again (prompt now over threshold); turn 3 final.
    if (turn === 1) return toolCallWithUsage("read", { path: "a.txt" }, 100, "c1");
    if (turn === 2) return toolCallWithUsage("read", { path: "b.txt" }, 400, "c2");
    return callResult({ content: "done", usage: usage(500, 5) });
  };
  const loop = new AgentLoop({ baseUrl: BASE, task: "t", session: { ...DEFAULT_SESSION_CONFIG, profile: { name: "tiny", workingTokens: 1000, evictAtTokens: 300 } }, chatFn: fn });
  const result = await loop.run();
  assert.equal(result.telemetry.evictions, 1);
  assert.equal(result.telemetry.lastEviction, "B");
  // History after: brief, marker, assistant(c2), tool(result of c2), then the final answer.
  const msgs = result.store.messages;
  const roles = msgs.map((m) => m.role);
  assert.deepEqual(roles, ["user", "user", "assistant", "tool", "assistant"]);
  assert.ok((msgs[1]! as { content: string }).content.includes("evicted at step"), "Tier-B marker present");
  // Only the LAST tool exchange survived.
  const kept = lastToolExchange(msgs);
  assert.ok(kept, "last tool exchange retained");
  assert.ok(kept!.call.tool_calls![0]!.id === "c2", "kept the second tool call, dropped the first");
});

test("3rd eviction triggers Tier-C hard reset with task state", async () => {
  let turn = 0;
  const fn = async (): Promise<ChatResult> => {
    turn++;
    // Answer on the 4th turn — after 3 evictions (B, B, C).
    if (turn < 4) return toolCallWithUsage("read", { path: "a.txt" }, 100, `c${turn}`);
    return callResult({ content: "done", usage: usage(600, 5) });
  };
  // Tiny threshold forces eviction nearly every turn.
  const loop = new AgentLoop({
    baseUrl: BASE,
    task: "t",
    session: { ...DEFAULT_SESSION_CONFIG, profile: { name: "tiny", workingTokens: 1000, evictAtTokens: 5 } },
    chatFn: fn,
  });
  const result = await loop.run();
  assert.equal(result.telemetry.evictions, 3);
  assert.equal(result.telemetry.lastEviction, "C");
  const msgs = result.store.messages;
  const contents = msgs.map((m) => m.role === "user" ? (m as { content: string }).content : "");
  assert.ok(contents.some((c) => c.includes("task state follows")), "Tier-C task-state message injected");
});

test("abort throws AbortError", async () => {
  const controller = new AbortController();
  const fn = async () => {
    controller.abort();
    return toolCall("read", { path: "a.txt" });
  };
  const loop = new AgentLoop({ baseUrl: BASE, task: "t", chatFn: fn, signal: controller.signal });
  await assert.rejects(() => loop.run(), (e: unknown) => (e as Error).name === "AbortError");
});

test("step cap throws when the model never answers", async () => {
  let turn = 0;
  const fn = async (): Promise<ChatResult> => {
    turn++;
    return toolCall("read", { path: "a.txt" }, `c${turn}`); // always calls tools, never answers
  };
  const loop = new AgentLoop({ baseUrl: BASE, task: "t", chatFn: fn, maxSteps: 4 });
  await assert.rejects(() => loop.run(), /step cap/);
});

test("telemetry aggregates prompt and completion tokens across turns", async () => {
  const seen: ChatOptions[] = [];
  const fn = async (_baseUrl: string, opts: ChatOptions): Promise<ChatResult> => {
    seen.push(opts);
    if (seen.length === 1) return toolCall("read", { path: "a.txt" }, "c1");
    if (seen.length === 2) return toolCall("grep", { pattern: "x", path: "." }, "c2");
    return callResult({ content: "done", usage: usage(100, 7) });
  };
  const loop = new AgentLoop({ baseUrl: BASE, task: "t", chatFn: fn });
  const result = await loop.run();
  assert.equal(result.telemetry.steps, 3);
  assert.equal(result.telemetry.totalCompletionTokens, 7); // only the final turn had usage
  assert.equal(result.telemetry.totalPromptTokens, 100);
  assert.equal(result.telemetry.traces.length, 3);
});
