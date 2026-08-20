/**
 * bash: run a shell command. cwd is fixed to the repo root — the model must
 * not touch arbitrary directories. Returns stdout+stderr plus the exit code,
 * tail-capped (60 lines / 4 KB) so a chatty or looping command cannot flood
 * context. No shell metacharacter escaping needed: we pass the raw command
 * to `sh -c` (that is exactly what an agent wants — real pipelines work).
 */

import { execFile } from "node:child_process";
import type { ToolSpec } from "./tool.ts";
import { REPO_ROOT } from "./root.ts";

export const BASH_TAIL_LINES = 60;
export const BASH_TAIL_CHARS = 4096;

export const bash: ToolSpec = {
  schema: {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a shell command in the repo root. Returns stdout+stderr and the exit code. " +
        "Output is tail-capped at 60 lines / 4 KB; a [truncated] marker means more was cut.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run (sh -c)." },
        },
        required: ["command"],
      },
    },
  },
  async run(args) {
    const command = String(args.command ?? "");
    if (command === "") throw new Error("bash: missing `command`");
    const { stdout, stderr, code } = await runCommand(command, REPO_ROOT);
    const combined = [stdout, stderr].filter(Boolean).join("");
    const exitInfo = `\n[exit ${code}]`;
    return cap(combined) + exitInfo;
  },
};

/** Run via sh -c, capturing stdout+stderr together (interleaving lost, fine). */
function runCommand(command: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  const { promise, resolve } = Promise.withResolvers<{ stdout: string; stderr: string; code: number }>();
  execFile("/bin/sh", ["-c", command], { cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      // Non-zero exit is a *result*, not a harness error — surface it.
      const code = typeof (err as NodeJS.ErrnoException).code === "number"
        ? (err as NodeJS.ErrnoException).code as unknown as number
        : 1;
      resolve({ stdout, stderr: stderr || (err as NodeJS.ErrnoException).message, code });
      return;
    }
    resolve({ stdout, stderr, code: 0 });
  });
  return promise;
}

/** Tail-cap to 60 lines / 4 KB, whichever binds first; marker when cut. */
function cap(output: string): string {
  const lines = output.split("\n");
  let joined = lines.slice(-BASH_TAIL_LINES).join("\n");
  let cut = lines.length > BASH_TAIL_LINES;
  if (joined.length > BASH_TAIL_CHARS) {
    joined = joined.slice(-BASH_TAIL_CHARS);
    cut = true;
  }
  return (cut ? "[truncated]\n" : "") + joined;
}
