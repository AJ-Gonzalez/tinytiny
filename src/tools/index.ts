/**
 * Tool executor: the registry of the six tools and the dispatch entry point.
 *
 * executeTool returns plain text ALWAYS — tool errors are returned as
 * `Error: …` text (tool feedback the model can retry), never thrown into the
 * loop. Every result passes through the hard token cap, so no single tool
 * can exceed the working budget regardless of a tool's own tighter default.
 */

import { capText, HARD_CAP_TOKENS } from "./cap.ts";
import type { ToolSpec } from "./tool.ts";
import { REPO_ROOT } from "./root.ts";
import { read } from "./read.ts";
import { write } from "./write.ts";
import { edit } from "./edit.ts";
import { bash } from "./bash.ts";
import { grep } from "./grep.ts";
import { glob } from "./glob.ts";

export { REPO_ROOT };

const TOOLS: Record<string, ToolSpec> = { read, write, edit, bash, grep, glob };

/** Schemas for the model, in the locked order. */
export function toolSchemas(): ToolSpec["schema"][] {
  return ["read", "write", "edit", "bash", "grep", "glob"].map((n) => TOOLS[n]!.schema);
}

/** Dispatch one tool call. Never throws: errors become tool feedback text. */
export async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = TOOLS[name];
  if (!tool) return `Error: unknown tool "${name}"`;
  try {
    const text = await tool.run({ ...args });
    return capText(text, HARD_CAP_TOKENS);
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}
