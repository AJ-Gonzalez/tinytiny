/**
 * write: create or overwrite a file. Content is passed as a single string.
 * Returns a short confirmation with byte count so the model can verify.
 */

import fs from "node:fs";
import type { ToolSpec } from "./tool.ts";

export const write: ToolSpec = {
  schema: {
    type: "function",
    function: {
      name: "write",
      description: "Create or overwrite a file with the given content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path, relative to the repo root." },
          content: { type: "string", description: "Full file content to write." },
        },
        required: ["path", "content"],
      },
    },
  },
  async run(args) {
    const path = String(args.path);
    const content = String(args.content ?? "");
    if (!path) throw new Error("write: missing `path`");
    fs.writeFileSync(path, content, "utf8");
    return `wrote ${path} (${Buffer.byteLength(content, "utf8")} bytes)`;
  },
};
