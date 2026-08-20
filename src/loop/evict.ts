/**
 * Eviction markers and the Tier-C task-state template.
 *
 * Eviction is the one deliberate, rare mutation to the append-only history
 * (DESIGN D5: evict-don't-summarize; world is on disk). The marker text is
 * part of the model contract — it must tell the model context was dropped
 * and to re-read before acting. Tier-C's task state is harness-written from
 * what the loop actually did (goal, files touched, tests, open items).
 */

import type { ChatMessage } from "../prompt/messages.ts";

/** What the loop knows about the task for a Tier-C reset. */
export interface TaskState {
  goal: string;
  filesTouched: string[];
  tests: string[];
  openItems: string[];
}

/** Marker for a Tier-B collapse. Mentions the step so the model can tell age. */
export function tierBMarker(step: number, turnsDropped: number): string {
  return `[history evicted at step ${step}: ${turnsDropped} turns dropped. Files on disk are authoritative; re-read before editing or judging.]`;
}

/**
 * The Tier-C reset message: a compact harness-written task state. Injected
 * as a fresh user message after the task brief. Plain text, terse — the
 * model re-reads files on disk for the real state.
 */
export function tierCTaskState(state: TaskState): string {
  const files = state.filesTouched.length > 0 ? state.filesTouched.join(", ") : "(none yet)";
  const tests = state.tests.length > 0 ? state.tests.join("; ") : "(none run)";
  const open = state.openItems.length > 0 ? state.openItems.join("; ") : "(none)";
  return [
    "[context reset — task state follows. Files on disk are authoritative; re-read before editing or judging.]",
    `Goal: ${state.goal}`,
    `Files touched: ${files}`,
    `Tests run: ${tests}`,
    `Open items: ${open}`,
  ].join("\n");
}

/** Find the last assistant tool_call and its matching tool result, for Tier-B. */
export function lastToolExchange(history: readonly ChatMessage[]): { call: ChatMessage & { role: "assistant" }; result: ChatMessage & { role: "tool" } } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    if (msg.role !== "assistant" || msg.tool_calls === undefined || msg.tool_calls.length === 0) continue;
    const call = msg;
    const result = history[i + 1];
    if (result !== undefined && result.role === "tool") {
      return { call, result };
    }
  }
  return null;
}
