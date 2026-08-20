/**
 * Result-size capping for tool output.
 *
 * The model context is the scarce resource; every tool result must fit a
 * hard token budget so a single runaway result cannot blow the working
 * budget. We have no tokenizer client-side (the server owns it), so we
 * estimate tokens from characters (~4 chars/token for English-ish code
 * text) — a safety net, not a precise count. Truncation is always *visible*
 * via the `[truncated]` marker, which the contract tells the model to read
 * as "more exists; re-read a narrower range".
 */

/** Hard cap for any single tool result, in estimated tokens. */
export const HARD_CAP_TOKENS = 2048;
/** Approx chars per token for estimation. */
export const CHARS_PER_TOKEN = 4;

/** Marker appended when output is cut. Mirrors the contract copy verbatim. */
export const TRUNCATED_MARKER = "[truncated]";

/** Rough token estimate for a text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Cap `text` to `maxTokens` estimated tokens, appending the truncated marker
 * when cut. Keeps the marker inside the budget.
 */
export function capText(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars - TRUNCATED_MARKER.length - 1);
  return cut + "\n" + TRUNCATED_MARKER;
}
