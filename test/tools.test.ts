/**
 * M2 contract tests: the six tools, caps, truncation markers, exit codes.
 * Each test defends an observable contract a plausible bug would break.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeTool, toolSchemas, REPO_ROOT } from "../src/tools/index.ts";
import { capText, estimateTokens, HARD_CAP_TOKENS, TRUNCATED_MARKER } from "../src/tools/cap.ts";
import { BASH_TAIL_CHARS } from "../src/tools/bash.ts";
import { GREP_MAX_MATCHES } from "../src/tools/grep.ts";
import { GLOB_MAX_PATHS } from "../src/tools/glob.ts";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tinytiny-tools-"));
}

test("toolSchemas returns all six in locked order with names", () => {
  const names = toolSchemas().map((s) => s.function.name);
  assert.deepEqual(names, ["read", "write", "edit", "bash", "grep", "glob"]);
});

test("capText truncates to the budget with the marker; estimateTokens is finite", () => {
  const big = "a".repeat(10_000);
  const out = capText(big, 100);
  assert.ok(out.length <= 100 * 4, "capped to ~100 tokens");
  assert.ok(out.endsWith(TRUNCATED_MARKER), "marker present when cut");
  assert.ok(!capText("short", 100).endsWith(TRUNCATED_MARKER), "no marker when under");
  assert.ok(estimateTokens("hello world") > 0);
  assert.equal(estimateTokens(""), 0);
});

test("hard cap applies to every executeTool result (read of a huge file)", async () => {
  const dir = tmpdir();
  const p = path.join(dir, "big.txt");
  fs.writeFileSync(p, "line\n".repeat(200_000));
  const out = await executeTool("read", { path: p });
  assert.ok(estimateTokens(out) <= HARD_CAP_TOKENS, "result within hard cap");
  assert.ok(out.includes(TRUNCATED_MARKER), "huge file truncates visibly");
});

test("read returns numbered lines and honors offset/limit", async () => {
  const dir = tmpdir();
  const p = path.join(dir, "f.txt");
  fs.writeFileSync(p, "a\nb\nc\nd\ne\n");
  assert.equal(await executeTool("read", { path: p, offset: 2, limit: 2 }), "2: b\n3: c");
  assert.equal(await executeTool("read", { path: p }), "1: a\n2: b\n3: c\n4: d\n5: e");
});

test("read rejects bad offset and missing file as tool feedback (not a throw)", async () => {
  const out = await executeTool("read", { path: "/nonexistent/nope.txt" });
  assert.ok(out.startsWith("Error:"), "missing file is Error: feedback");
  const bad = await executeTool("read", { path: "x", offset: 0 });
  assert.ok(bad.startsWith("Error:"), "offset 0 is rejected");
});

test("write creates/overwrites and reports byte count", async () => {
  const dir = tmpdir();
  const p = path.join(dir, "w.txt");
  const out = await executeTool("write", { path: p, content: "hello\n" });
  assert.ok(out.includes("wrote"), "confirmation");
  assert.equal(fs.readFileSync(p, "utf8"), "hello\n");
  assert.ok(estimateTokens(out) > 0);
});

test("edit replaces a unique old_string and reports the line", async () => {
  const dir = tmpdir();
  const p = path.join(dir, "e.txt");
  fs.writeFileSync(p, "one\ntwo\nthree\n");
  const out = await executeTool("edit", { path: p, old_string: "two", new_string: "TWO" });
  assert.ok(out.includes("line 2"), "reports the edited line");
  assert.equal(fs.readFileSync(p, "utf8"), "one\nTWO\nthree\n");
});

test("edit errors on ambiguity (multiple matches) and on zero matches", async () => {
  const dir = tmpdir();
  const p = path.join(dir, "amb.txt");
  fs.writeFileSync(p, "x y x\n");
  const multi = await executeTool("edit", { path: p, old_string: "x", new_string: "z" });
  assert.ok(multi.startsWith("Error:") && multi.includes("matches"), "ambiguous edit errors");
  assert.equal(fs.readFileSync(p, "utf8"), "x y x\n", "file untouched on ambiguity");
  const zero = await executeTool("edit", { path: p, old_string: "zzz", new_string: "q" });
  assert.ok(zero.startsWith("Error:") && zero.includes("not found"), "zero match errors");
});

test("bash returns output + exit code, capped, cwd = repo root", async () => {
  const out = await executeTool("bash", { command: "pwd" });
  assert.ok(out.includes(REPO_ROOT), "cwd is the repo root, not the caller cwd");
  assert.ok(out.includes("[exit 0]"), "exit code surfaced");

  const fail = await executeTool("bash", { command: "exit 3" });
  assert.ok(fail.includes("[exit 3]"), "non-zero exit reported as a result, not a throw");

  // Cap: a very chatty command must be tail-capped under the char budget.
  const noisy = await executeTool("bash", { command: "yes x | head -c 20000" });
  assert.ok(noisy.length <= BASH_TAIL_CHARS + 64, "bash output tail-capped");
  assert.ok(noisy.includes("[truncated]"), "marker present when bash output cut");
});

test("bash missing command is tool feedback", async () => {
  const out = await executeTool("bash", { args: {} } as never);
  assert.ok(out.startsWith("Error:"), "missing command errors");
});

test("grep returns path:line matches, caps at 50, no match is empty not error", async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "a.txt"), "foo bar\nbaz\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "nope\nfoo!\n");
  const out = await executeTool("grep", { pattern: "foo", path: dir });
  assert.ok(out.includes("a.txt:1: foo bar"), "match format path:line:text");
  assert.ok(out.includes("b.txt:2: foo!"), "matches across files");

  const none = await executeTool("grep", { pattern: "zzz-not-there", path: dir });
  assert.equal(none, "", "no matches returns empty, not an error");

  // Cap at GREP_MAX_MATCHES.
  const big = tmpdir();
  fs.writeFileSync(path.join(big, "m.txt"), "hit\n".repeat(GREP_MAX_MATCHES + 10));
  const capped = await executeTool("grep", { pattern: "hit", path: big });
  assert.ok(capped.includes(`[truncated: more than ${GREP_MAX_MATCHES}`), "cap marker");
  assert.ok(estimateTokens(capped) <= HARD_CAP_TOKENS);
});

test("grep invalid regex and missing target are tool feedback", async () => {
  assert.ok((await executeTool("grep", { pattern: "(", path: "." })).startsWith("Error:"));
  assert.ok((await executeTool("grep", { pattern: "x", path: "/no/such/dir" })).startsWith("Error:"));
});

test("glob expands patterns, caps at 100, includes hidden", async () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, ".hidden.ts"), "");
  fs.writeFileSync(path.join(dir, "a.ts"), "");
  fs.writeFileSync(path.join(dir, "b.ts"), "");
  const rel = path.relative(process.cwd(), dir);
  const out = await executeTool("glob", { pattern: `${rel}/*.ts` });
  assert.ok(out.includes("a.ts") && out.includes("b.ts"), "expands matching paths");
  const hidden = await executeTool("glob", { pattern: `${rel}/.*.ts` });
  assert.ok(hidden.includes(".hidden.ts"), "hidden files included");

  // Cap at GLOB_MAX_PATHS.
  const many = tmpdir();
  for (let i = 0; i < GLOB_MAX_PATHS + 5; i++) fs.writeFileSync(path.join(many, `f${i}.txt`), "");
  const relMany = path.relative(process.cwd(), many);
  const capped = await executeTool("glob", { pattern: `${relMany}/*.txt` });
  assert.ok(capped.includes(`[truncated: more than ${GLOB_MAX_PATHS}`), "cap marker");
});

test("unknown tool is tool feedback, never a throw", async () => {
  const out = await executeTool("nope", {});
  assert.equal(out, 'Error: unknown tool "nope"');
});

test("executeTool never throws even when a tool throws internally", async () => {
  // read of a directory throws EISDIR on readFileSync — must be feedback.
  const dir = tmpdir();
  const out = await executeTool("read", { path: dir });
  assert.ok(out.startsWith("Error:"), "tool error surfaced as text");
});
