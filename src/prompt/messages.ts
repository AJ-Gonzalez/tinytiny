/**
 * Wire types (OpenAI chat-completions shape) and the MessageStore.
 *
 * Storage invariants (D6/D7, verified 2026-08-19):
 * - Assistant content is stored verbatim minus think: `reasoning_content`
 *   is consumed at ingest and NEVER enters history.
 * - Tool calls are stored as the server's structured `tool_calls` objects,
 *   byte-for-byte, and re-sent as-is — the server renders deterministically,
 *   which is what keeps the KV cache warm (cached_tokens > 0 on extension).
 * - History is append-only. Mutation happens only at eviction (M3).
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON-encoded arguments, exactly as the server generated them. */
    arguments: string;
  };
}

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
}

export interface ToolMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

/** Server response message: what the model generated this turn. */
export interface CompletionMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
  reasoning_content?: string;
}

export interface ChatCompletion {
  choices: Array<{
    message: CompletionMessage;
    finish_reason: string | null;
  }>;
  usage?: Usage;
}

export interface ChatCompletionChunk {
  choices: Array<{
    delta: {
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
  usage?: Usage;
}

/**
 * Append-only conversation history. Holds the exact ChatMessage objects
 * that were sent to the server, so the builder can re-send them
 * byte-identical (same references, no re-serialization).
 */
export class MessageStore {
  private readonly history: ChatMessage[] = [];

  /** The stored history. Treat as immutable. */
  get messages(): readonly ChatMessage[] {
    return this.history;
  }

  get length(): number {
    return this.history.length;
  }

  addSystem(content: string): void {
    this.history.push({ role: "system", content });
  }

  addUser(content: string): void {
    this.history.push({ role: "user", content });
  }

  addAssistant(content: string | null, toolCalls?: ToolCall[]): void {
    const msg: AssistantMessage = { role: "assistant", content };
    if (toolCalls !== undefined && toolCalls.length > 0) msg.tool_calls = toolCalls;
    this.history.push(msg);
  }

  addTool(toolCallId: string, content: string): void {
    this.history.push({ role: "tool", tool_call_id: toolCallId, content });
  }

  /**
   * Ingest a server completion: content verbatim, tool_calls verbatim,
   * reasoning_content dropped at the door.
   */
  ingestCompletion(completion: CompletionMessage): void {
    this.addAssistant(completion.content, completion.tool_calls);
  }

  /**
   * Tier-B eviction (DESIGN): collapse history to the stable prefix (the
   * task brief), an eviction marker, and the last tool exchange (the
   * assistant tool_call PLUS its result — a `tool` message is invalid
   * without its preceding assistant tool_call). Drops everything between.
   * This is the documented, deliberate, rare exception to append-only; a
   * full cold reprocess follows.
   */
  evictTierB(taskBrief: string, marker: string, lastTool: { call: AssistantMessage; result: ToolMessage } | null): void {
    const kept: ChatMessage[] = [{ role: "user", content: taskBrief }];
    if (marker.length > 0) kept.push({ role: "user", content: marker });
    if (lastTool !== null) {
      kept.push(lastTool.call);
      kept.push(lastTool.result);
    }
    this.history.splice(0, this.history.length, ...kept);
  }

  /**
   * Tier-C hard reset (DESIGN): fresh context of task brief + a
   * harness-written task state (goal, files touched, tests, open items).
   * Used on user request or the 3rd eviction.
   */
  evictTierC(taskBrief: string, taskState: string): void {
    this.history.splice(0, this.history.length, { role: "user", content: taskBrief }, { role: "user", content: taskState });
  }
}
