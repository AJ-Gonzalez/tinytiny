/**
 * glob: expand a glob pattern to matching paths, one per line, capped at
 * 100 (marker when cut). Uses Node's fs.globSync (native, gitignore-aware
 * via dot/glob options). Pattern is relative to the repo root.
 */

import fs from "node:fs";
import type { ToolSpec } from "./tool.ts";

export const GLOB_MAX_PATHS = 100;

export const glob: ToolSpec = {
  schema: {
    type: "function",
    function: {
      name: "glob",
      description:
        "Expand a glob pattern (e.g. 'src/**/*.ts') to matching paths. " +
        "Returns up to 100 paths, one per line. Hidden files included.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern relative to the repo root." },
        },
        required: ["pattern"],
      },
    },
  },
  async run(args) {
    const pattern = String(args.pattern ?? "");
    if (pattern === "") throw new Error("glob: missing `pattern`");
    const paths = fs.globSync(pattern, { dot: true } as fs.GlobOptions);
    const cut = paths.length > GLOB_MAX_PATHS;
    const shown = cut ? paths.slice(0, GLOB_MAX_PATHS) : paths;
    return (cut ? `[truncated: more than ${GLOB_MAX_PATHS} paths]\n` : "") + shown.join("\n");
  },
};
