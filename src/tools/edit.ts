/**
 * edit: replace an exact old_string with new_string. Errors on ambiguity —
 * zero or multiple matches must not guess. This is the safety-critical tool:
 * a silent wrong edit corrupts source, so we fail loudly instead.
 */

import fs from "node:fs";
import type { ToolSpec } from "./tool.ts";

export const edit: ToolSpec = {
  schema: {
    type: "function",
    function: {
      name: "edit",
      description:
        "Replace an exact substring in a file. old_string must occur exactly once; " +
        "error otherwise (re-read and use a more specific string).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the repo root." },
          old_string: { type: "string", description: "Exact text to find (must match once)." },
          new_string: { type: "string", description: "Replacement text." },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  async run(args) {
    const path = String(args.path);
    const oldString = String(args.old_string ?? "");
    const newString = String(args.new_string ?? "");
    if (!path) throw new Error("edit: missing `path`");
    if (oldString === "") throw new Error("edit: old_string must not be empty");

    const text = fs.readFileSync(path, "utf8");
    const first = text.indexOf(oldString);
    if (first === -1) throw new Error(`edit: old_string not found in ${path}`);
    const second = text.indexOf(oldString, first + 1);
    if (second !== -1) throw new Error(`edit: old_string matches ${countMatches(text, oldString)} times; be more specific`);

    fs.writeFileSync(path, text.slice(0, first) + newString + text.slice(first + oldString.length), "utf8");
    const line = text.slice(0, first).split("\n").length;
    return `edited ${path} at line ${line}: replaced 1 occurrence`;
  },
};

function countMatches(text: string, needle: string): number {
  let count = 0;
  let idx = text.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = text.indexOf(needle, idx + needle.length);
  }
  return count;
}
