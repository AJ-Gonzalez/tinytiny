/**
 * OpenAI-compatible chat client for llama-server.
 *
 * Transport is stdlib `node:http` (not fetch): fetch's undici defaults impose
 * a 300s headers timeout, and a single generation at ~1 t/s can exceed that.
 * A localhost agent harness must never time out mid-generation — cancel is
 * explicit, via AbortSignal. No socket timeout is set.
 *
 * Non-streaming (`chat`) for exact usage/cache accounting (the cache-warmth
 * gate reads `prompt_tokens_details.cached_tokens`). Streaming (`chatStream`)
 * yields normalized events — reasoning and content deltas separate, tool_call
 * fragments per index — which is what the M3 loop and M4/M5 surfaces consume.
 */

import http from "node:http";
import type { IncomingMessage } from "node:http";

import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatMessage,
  CompletionMessage,
  ToolCall,
  ToolSchema,
  Usage,
} from "./prompt/messages.ts";

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  /** Pass `cache_prompt:false` to force a cold slot reprocess (diagnostics). */
  cachePrompt?: boolean;
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  reasoning: string;
  usage?: Usage;
  finishReason: string | null;
}

export type StreamEvent =
  | { kind: "reasoning"; text: string }
  | { kind: "content"; text: string }
  | { kind: "tool_call"; index: number; id?: string; name?: string; args?: string }
  | { kind: "finish"; finishReason: string | null };

const ENDPOINT_PATH = "/v1/chat/completions";

/**
 * POST a JSON body; resolve with the response stream when the status is 2xx,
 * reject with the response text otherwise. Abort destroys the socket.
 */
function request(
  baseUrl: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<IncomingMessage> {
  const url = new URL(baseUrl);
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port === "" ? 80 : Number(url.port),
        path: ENDPOINT_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res);
          return;
        }
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res.on("end", () => {
          reject(new Error(`chat request failed: HTTP ${res.statusCode} ${data.slice(0, 500)}`));
        });
      },
    );

    req.on("error", reject);
    if (signal !== undefined) {
      if (signal.aborted) {
        req.destroy(new DOMException("aborted", "AbortError"));
      } else {
        signal.addEventListener("abort", () => {
          req.destroy(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }
    }
    req.end(payload);
  });
}

async function readJson<T>(res: IncomingMessage): Promise<T> {
  let data = "";
  for await (const chunk of res) data += chunk.toString();
  return JSON.parse(data) as T;
}

/** Single (non-streaming) completion. Returns the full ChatResult. */
export async function chat(
  baseUrl: string,
  opts: ChatOptions,
): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: "local",
    messages: opts.messages,
    stream: false,
  };
  if (opts.tools !== undefined) body.tools = opts.tools;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.cachePrompt !== undefined) body.cache_prompt = opts.cachePrompt;

  const res = await request(baseUrl, body, opts.signal);
  const completion = await readJson<ChatCompletion>(res);
  const choice = completion.choices[0];
  if (choice === undefined) throw new Error("chat response had no choices");
  return fromCompletion(choice.message, choice.finish_reason, completion.usage);
}

/** Streaming completion: yields normalized events until finish. */
export async function* chatStream(
  baseUrl: string,
  opts: ChatOptions,
): AsyncGenerator<StreamEvent> {
  const body: Record<string, unknown> = {
    model: "local",
    messages: opts.messages,
    stream: true,
  };
  if (opts.tools !== undefined) body.tools = opts.tools;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.cachePrompt !== undefined) body.cache_prompt = opts.cachePrompt;

  const res = await request(baseUrl, body, opts.signal);
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const value of res) {
    buffer += decoder.decode(value as Buffer, { stream: true });

    // SSE events are separated by blank lines; each event is `data: ...`.
    for (;;) {
      const sep = buffer.search(/\r?\n\r?\n/);
      if (sep === -1) break;
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + (buffer.startsWith("\r\n", sep) ? 4 : 2));
      const data = rawEvent
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data === "[DONE]") return;
      if (data.length === 0) continue;
      let chunk: ChatCompletionChunk;
      try {
        chunk = JSON.parse(data) as ChatCompletionChunk;
      } catch {
        continue; // non-JSON keepalive or partial; skip
      }
      yield* eventsFromChunk(chunk);
    }
  }
}

function* eventsFromChunk(chunk: ChatCompletionChunk): Generator<StreamEvent> {
  const choice = chunk.choices[0];
  if (choice === undefined) return;
  const delta = choice.delta;
  if (delta.reasoning_content !== undefined && delta.reasoning_content.length > 0) {
    yield { kind: "reasoning", text: delta.reasoning_content };
  }
  if (delta.content !== undefined && delta.content !== null && delta.content.length > 0) {
    yield { kind: "content", text: delta.content };
  }
  if (delta.tool_calls !== undefined) {
    for (const tc of delta.tool_calls) {
      const ev: StreamEvent = { kind: "tool_call", index: tc.index ?? 0 };
      if (tc.id !== undefined) ev.id = tc.id;
      if (tc.function?.name !== undefined) ev.name = tc.function.name;
      if (tc.function?.arguments !== undefined) ev.args = tc.function.arguments;
      yield ev;
    }
  }
  if (choice.finish_reason !== null) {
    yield { kind: "finish", finishReason: choice.finish_reason };
  }
}

/** Aggregate a stream into a ChatResult (used by tests and the M3 loop). */
export async function accumulate(
  events: AsyncGenerator<StreamEvent> | AsyncIterable<StreamEvent>,
): Promise<ChatResult> {
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  const calls = new Map<number, { id?: string; name: string; args: string }>();

  for await (const ev of events) {
    switch (ev.kind) {
      case "reasoning":
        reasoning += ev.text;
        break;
      case "content":
        content += ev.text;
        break;
      case "tool_call": {
        const cur = calls.get(ev.index) ?? { name: "", args: "" };
        if (ev.id !== undefined) cur.id = ev.id;
        if (ev.name !== undefined) cur.name += ev.name;
        if (ev.args !== undefined) cur.args += ev.args;
        calls.set(ev.index, cur);
        break;
      }
      case "finish":
        finishReason = ev.finishReason;
        break;
    }
  }

  const toolCalls: ToolCall[] = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, c]) => ({
      id: c.id ?? "",
      type: "function",
      function: { name: c.name, arguments: c.args },
    }));

  return {
    content: content.length > 0 ? content : null,
    toolCalls,
    reasoning,
    finishReason,
  };
}

function fromCompletion(
  message: CompletionMessage,
  finishReason: string | null,
  usage?: Usage,
): ChatResult {
  const result: ChatResult = {
    content: message.content,
    toolCalls: message.tool_calls ?? [],
    reasoning: message.reasoning_content ?? "",
    finishReason,
  };
  if (usage !== undefined) result.usage = usage;
  return result;
}
