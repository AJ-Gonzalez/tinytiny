/**
 * grep: find lines matching a regex, one `path:line: text` per match, capped
 * at 50 matches (marker when cut). Search a single file or a directory
 * (recursive, skips .git and node_modules). Missing file / no matches are
 * distinct: no matches returns empty (not an error) so the model can proceed.
 */

import fs from "node:fs";
import path from "node:path";
import type { ToolSpec } from "./tool.ts";

export const GREP_MAX_MATCHES = 50;
const SKIP_DIRS = new Set([".git", "node_modules", ".tinytiny"]);

export const grep: ToolSpec = {
  schema: {
    type: "function",
    function: {
      name: "grep",
      description:
        "Find lines matching a regular expression. Searches a file or directory (recursive, " +
        "skips .git/node_modules). Returns up to 50 matches as path:line: text.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression (no slashes)." },
          path: { type: "string", description: "File or directory to search (default: repo root)." },
        },
        required: ["pattern"],
      },
    },
  },
  async run(args) {
    const pattern = String(args.pattern ?? "");
    const target = args.path === undefined ? "." : String(args.path);
    if (pattern === "") throw new Error("grep: missing `pattern`");
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      throw new Error(`grep: invalid regex: ${(e as Error).message}`);
    }
    if (!fs.existsSync(target)) throw new Error(`grep: no such file or directory: ${target}`);

    const files = fs.statSync(target).isDirectory() ? walk(target) : [target];
    const matches: string[] = [];
    for (const file of files) {
      if (matches.length >= GREP_MAX_MATCHES) break;
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue; // unreadable (binary/permission) — skip silently
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && matches.length < GREP_MAX_MATCHES; i++) {
        if (re.test(lines[i]!)) matches.push(`${file}:${i + 1}: ${lines[i]!}`);
      }
    }
    const cut = matches.length >= GREP_MAX_MATCHES;
    return (cut ? `[truncated: more than ${GREP_MAX_MATCHES} matches]\n` : "") + matches.join("\n");
  },
};

/** Recursive file walk, tolerant of unreadable dirs. */
function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...walk(full));
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}
