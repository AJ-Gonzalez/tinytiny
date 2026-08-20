/**
 * Tool model shared by the executor and the loop.
 *
 * A tool is a function schema (given to the model) plus a runner that
 * returns plain text. Runners THROW on user-facing errors — executeTool
 * catches them and returns `Error: …` text, so the model sees the failure
 * as tool feedback and can retry (it never crashes the loop).
 */

import type { ToolSchema } from "../prompt/messages.ts";

export interface ToolSpec {
  schema: ToolSchema;
  run: (args: Record<string, unknown>) => Promise<string>;
}
