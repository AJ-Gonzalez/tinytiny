/**
 * read: return a file's content with line numbers, optionally a line range.
 * Line numbers are 1-based; offset/limit select a window. Whole file when
 * neither is given. Output is plain text, one `N: text` line per line.
 */

import fs from "node:fs";
import type { ToolSpec } from "./tool.ts";

export const read: ToolSpec = {
  schema: {
    type: "function",
    function: {
      name: "read",
      description: "Read a file, optionally a line range. Lines are numbered 1-based.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the repo root." },
          offset: { type: "integer", description: "1-based first line to show (default 1)." },
          limit: { type: "integer", description: "Max lines to show (default: whole file)." },
        },
        required: ["path"],
      },
    },
  },
  async run(args) {
    const path = String(args.path);
    if (!path) throw new Error("read: missing `path`");
    const offset = args.offset === undefined ? 1 : Number(args.offset);
    const limit = args.limit === undefined ? Infinity : Number(args.limit);
    if (args.offset !== undefined && (!Number.isInteger(offset) || offset < 1))
      throw new Error("read: offset must be an integer >= 1");
    if (args.limit !== undefined && (!Number.isInteger(limit) || limit < 1))
      throw new Error("read: limit must be an integer >= 1");

    const text = fs.readFileSync(path, "utf8");
    // A trailing newline would otherwise render a spurious empty numbered line.
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    const start = offset - 1;
    const shown = lines.slice(start, start + limit);
    return shown.map((l, i) => `${start + i + 1}: ${l}`).join("\n");
  },
};
