/**
 * Strict-extension prompt builder.
 *
 * The request is exactly the stored history — a strict append over the
 * previous request, so the server's slot cache stays warm turn over turn.
 * There is deliberately NO system-role message: a system message breaks tool
 * calling on this arch (LESSONS.md); the contract rides at the top of the
 * first user message via `taskBrief`. This builder returns a defensive copy
 * so callers cannot mutate the store's array, and is the seam to reintroduce
 * a system message if the model's tool handling improves.
 */

import { MessageStore, type ChatMessage } from "./messages.ts";

/** Assemble the next request's messages: the stored history, copied. */
export function buildRequest(store: MessageStore): ChatMessage[] {
  return [...store.messages];
}
