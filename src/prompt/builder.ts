/**
 * Strict-extension prompt builder.
 *
 * Every request is [system, ...stored history] — a strict append over the
 * previous request, where the store holds exactly what was sent (system
 * message aside). Callers add user turns to the MessageStore before
 * building, so the store always mirrors the wire history and the server's
 * slot cache stays warm turn over turn.
 */

import { MessageStore, type ChatMessage } from "./messages.ts";

/** Assemble the next request's messages: system prefix + stored history. */
export function buildRequest(
  store: MessageStore,
  systemPrompt: string,
): ChatMessage[] {
  return [
    { role: "system", content: systemPrompt },
    ...store.messages,
  ];
}
