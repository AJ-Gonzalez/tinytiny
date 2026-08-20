/**
 * AgentLoop: the M3 agent loop.
 *
 * Runs one task against the model until the model stops calling tools and
 * produces a final answer. Core invariants:
 * - Strict-extension history (buildRequest re-sends stored messages
 *   byte-identical → cache warmth), mutation only at eviction.
 * - Retry-with-steering: a failed or degenerate turn (HTTP 500 from bad
 *   tool args, or no content AND no tool call) appends a steering user
 *   message and resends. A failed turn never mutates the store, so the
 *   retry is still a valid extension (M1 gate lesson).
 * - Budget: when prompt_tokens crosses the profile's evict threshold,
 *   Tier-B collapse; on the 3rd eviction, Tier-C hard reset. Eviction
 *   deliberately costs a cold reprocess (DESIGN D5).
 * - Non-streaming `chat`: gives exact usage/cache accounting. Streaming
 *   display is the M4 surfaces' concern.
 *
 * Cancellation: pass an AbortSignal; the loop checks it between turns and
 * the client destroys the socket mid-request.
 */

import { chat, type ChatOptions, type ChatResult } from "../client.ts";
import { buildRequest } from "../prompt/builder.ts";
import { MessageStore, type ToolCall, type ToolSchema, type Usage } from "../prompt/messages.ts";
import { DEFAULT_SESSION_CONFIG, taskBrief, type SessionConfig } from "../prompt/session.ts";
import { executeTool, toolSchemas } from "../tools/index.ts";
import { lastToolExchange, tierBMarker, tierCTaskState, type TaskState } from "./evict.ts";

/** Client function, injectable for tests. */
export type ChatFn = (baseUrl: string, opts: ChatOptions) => Promise<ChatResult>;

export interface AgentOptions {
  baseUrl: string;
  /** Session config (contract + budget profile). Defaults to the standard. */
  session?: SessionConfig;
  /** The task instruction, appended to the task brief as the first user message. */
  task: string;
  /** Tools exposed to the model. Defaults to all six. */
  tools?: ToolSchema[];
  /** Hard turn cap — a safety net against a non-terminating model. */
  maxSteps?: number;
  /** Retries per turn before giving up on that turn. */
  retriesPerTurn?: number;
  /**
   * Per-turn max_tokens. Generous guard ONLY (LESSONS: max_tokens shares
   * the reasoning+completion budget; a tight cap cuts thinking before the
   * tool call). Never the binding constraint — the model self-terminates.
   */
  maxTokens?: number;
  signal?: AbortSignal;
  /** Client to use. Injectable for tests; defaults to the real llama-server client. */
  chatFn?: ChatFn;
  /**
   * Called when a request fails to reach the server (connection refused /
   * reset — the engine died mid-run, a known crash on this machine,
   * LESSONS). The loop waits for this to resolve, then retries the SAME
   * turn WITHOUT steering (a dead server is not the model's fault).
   * Implementations should restart the engine (e.g. LlamaServer.restart).
   */
  onConnectionError?: () => Promise<void>;
}

/** Per-turn accounting, aggregated for the final telemetry. */
export interface StepTrace {
  step: number;
  usage?: Usage;
  toolCalls: number;
  /** Names of the tools the model called this step (debug/telemetry). */
  tools?: string[];
  evicted: "B" | "C" | null;
}
export interface AgentResult {
  /** The model's final answer (content of the last non-tool turn). */
  answer: string | null;
  store: MessageStore;
  /** Budget telemetry. */
  telemetry: {
    steps: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    evictions: number;
    lastEviction: "B" | "C" | null;
    traces: StepTrace[];
  };
}

const DEFAULT_MAX_STEPS = 30;
const DEFAULT_RETRIES = 3;
const DEFAULT_MAX_TOKENS = 4096;

/** Steering copy for a degenerate turn (see module doc). */
const STEER = [
  "That reply was not usable.",
  "If a tool call is needed, emit exactly one with valid JSON arguments.",
  "Otherwise answer concisely. No prose, no XML.",
].join(" ");

/** Socket-level failure (engine died), NOT an HTTP response (e.g. 500 bad args). */
function isConnectionError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { code?: unknown; message?: unknown };
  const code = typeof err.code === "string" ? err.code : "";
  if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "ECONNABORTED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND"].includes(code)) {
    return true;
  }
  return typeof err.message === "string" && /socket hang up|connect /i.test(err.message);
}

export class AgentLoop {
  private readonly store = new MessageStore();
  private readonly opts: {
    baseUrl: string;
    task: string;
    maxSteps: number;
    retriesPerTurn: number;
    maxTokens: number;
    tools: ToolSchema[];
    chatFn: ChatFn;
    onConnectionError?: () => Promise<void>;
    session?: SessionConfig;
    signal?: AbortSignal;
  };
  private readonly taskState: TaskState;
  private evictions = 0;
  private lastEviction: "B" | "C" | null = null;
  private readonly traces: StepTrace[] = [];

  constructor(opts: AgentOptions) {
    this.opts = {
      maxSteps: opts.maxSteps ?? DEFAULT_MAX_STEPS,
      retriesPerTurn: opts.retriesPerTurn ?? DEFAULT_RETRIES,
      maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      tools: opts.tools ?? toolSchemas(),
      chatFn: opts.chatFn ?? chat,
      baseUrl: opts.baseUrl,
      task: opts.task,
    };
    if (opts.session !== undefined) this.opts.session = opts.session;
    if (opts.signal !== undefined) this.opts.signal = opts.signal;
    if (opts.onConnectionError !== undefined) this.opts.onConnectionError = opts.onConnectionError;
    this.taskState = { goal: opts.task, filesTouched: [], tests: [], openItems: [] };
  }

  get session(): SessionConfig {
    return this.opts.session ?? DEFAULT_SESSION_CONFIG;
  }

  /** Current per-step traces (readable after a throw for diagnostics). */
  get traceLog(): readonly StepTrace[] {
    return this.traces;
  }

  private trace(step: number, usage: Usage | undefined, toolCalls: number, tools: string[] | undefined, evicted: "B" | "C" | null): StepTrace {
    const t: StepTrace = { step, toolCalls, evicted };
    if (usage !== undefined) t.usage = usage;
    if (tools !== undefined && tools.length > 0) t.tools = tools;
    return t;
  }

  /** Run the task to completion (final answer or step cap). */
  async run(): Promise<AgentResult> {
    const brief = taskBrief(this.session.contract, this.opts.task);
    this.store.addUser(brief);

    for (let step = 1; step <= this.opts.maxSteps; step++) {
      if (this.opts.signal?.aborted) throw new DOMException("aborted", "AbortError");

      const evicted = this.evictIfOverBudget(brief, step);
      const result = await this.stepWithRetry();

      // Feed tool results, then continue. No tool calls + content = final answer.
      if (result.toolCalls.length > 0) {
        this.store.ingestCompletion({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
        for (const call of result.toolCalls) {
          const out = await this.execute(call);
          this.store.addTool(call.id, out);
        }
        this.traces.push(this.trace(step, result.usage, result.toolCalls.length, result.toolCalls.map((c) => c.function.name), evicted));
        continue;
      }

      // Final answer: content with no tool call. Ingest the assistant message
      // so the answer is part of history (useful for later turns).
      this.store.ingestCompletion({ role: "assistant", content: result.content });
      this.traces.push(this.trace(step, result.usage, 0, undefined, evicted));
      return {
        answer: result.content,
        store: this.store,
        telemetry: this.summarize(),
      };
    }

    throw new Error(`agent hit the ${this.opts.maxSteps}-step cap without a final answer`);
  }

  /** One turn, with retry-with-steering on 500 or a degenerate (empty) reply. */
  private async stepWithRetry(): Promise<ChatResult> {
    for (let attempt = 1; attempt <= this.opts.retriesPerTurn; attempt++) {
      try {
        const callOpts: ChatOptions = {
          messages: buildRequest(this.store),
          tools: this.opts.tools,
          maxTokens: this.opts.maxTokens,
        };
        if (this.opts.signal !== undefined) callOpts.signal = this.opts.signal;
        const result = await this.opts.chatFn(this.opts.baseUrl, callOpts);
        const degenerate = result.toolCalls.length === 0 && (result.content === null || result.content.trim() === "");
        if (!degenerate) return result;
        if (attempt === this.opts.retriesPerTurn) {
          // A degenerate final attempt must not masquerade as an answer.
          throw new Error(`agent produced a degenerate turn (no tool call, no content) after ${attempt} attempts`);
        }
        this.store.addUser(STEER);
      } catch (e) {
        if (isConnectionError(e)) {
          // The engine died mid-run (known crash). Restart and retry the SAME
          // turn — no steering, no attempt consumed. A connection failure is
          // not the model's fault.
          if (this.opts.onConnectionError === undefined) throw e;
          await this.opts.onConnectionError();
          attempt--; // this attempt didn't reach the model; don't burn it
          continue;
        }
        if (attempt === this.opts.retriesPerTurn) throw e;
        this.store.addUser(STEER);
      }
    }
    // unreachable; keep TS happy
    throw new Error("unreachable");
  }

  /** Dispatch one tool call; malformed JSON args become tool feedback. */
  private async execute(call: ToolCall): Promise<string> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    } catch {
      this.trackFile(call);
      return `Error: tool call arguments were not valid JSON: ${call.function.arguments}`;
    }
    this.trackFile(call);
    if (call.function.name === "bash" && typeof args.command === "string") {
      this.trackTest(args.command);
    }
    return executeTool(call.function.name, args);
  }

  /** Evict when the last usage crossed the profile's evict threshold. */
  private evictIfOverBudget(brief: string, step: number): "B" | "C" | null {
    const last = this.traces[this.traces.length - 1];
    const promptTokens = last?.usage?.prompt_tokens ?? 0;
    const threshold = this.session.profile.evictAtTokens;
    if (promptTokens < threshold) return null;

    if (this.evictions >= 2) {
      // 3rd eviction → Tier-C hard reset.
      this.store.evictTierC(brief, tierCTaskState(this.taskState));
      this.evictions++;
      this.lastEviction = "C";
      return "C";
    }
    const exchange = lastToolExchange(this.store.messages);
    this.store.evictTierB(brief, tierBMarker(step, Math.max(0, this.store.length - 2)), exchange);
    this.evictions++;
    this.lastEviction = "B";
    return "B";
  }

  private trackFile(call: ToolCall): void {
    let p: unknown;
    try {
      p = (JSON.parse(call.function.arguments) as Record<string, unknown>).path;
    } catch {
      return;
    }
    if (typeof p === "string" && !this.taskState.filesTouched.includes(p)) {
      this.taskState.filesTouched.push(p);
    }
  }

  private trackTest(command: string): void {
    if (/test|spec/i.test(command) && !this.taskState.tests.includes(command)) {
      this.taskState.tests.push(command);
    }
  }

  private summarize() {
    let prompt = 0;
    let completion = 0;
    for (const t of this.traces) {
      prompt += t.usage?.prompt_tokens ?? 0;
      completion += t.usage?.completion_tokens ?? 0;
    }
    return {
      steps: this.traces.length,
      totalPromptTokens: prompt,
      totalCompletionTokens: completion,
      evictions: this.evictions,
      lastEviction: this.lastEviction,
      traces: this.traces,
    };
  }
}
