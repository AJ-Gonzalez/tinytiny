/**
 * Session configuration: contract copy + context-budget profile.
 * Budget profiles are carried here and enforced by the eviction logic in M3;
 * they are data now so the default and conservative presets are explicit.
 *
 * Contract placement: there is deliberately NO system-role message — a
 * system message breaks tool calling on this arch (LESSONS.md). The contract
 * rides at the top of the FIRST user message (the task brief), which is the
 * stable cached prefix either way.
 */

export interface BudgetProfile {
  name: string;
  /** Soft working budget (prompt tokens) before eviction is considered. */
  workingTokens: number;
  /** Hard eviction threshold (prompt tokens). */
  evictAtTokens: number;
}

/** Default: 24K working, evict at 75%. */
export const DEFAULT_PROFILE: BudgetProfile = {
  name: "default",
  workingTokens: 24_000,
  evictAtTokens: 18_000,
};

/** Conservative preset (off by default, per PENDING.md). */
export const CONSERVATIVE_PROFILE: BudgetProfile = {
  name: "conservative",
  workingTokens: 24_000,
  evictAtTokens: 16_000,
};

export interface SessionConfig {
  /** Contract copy. Approved 2026-08-19 (copy may be edited later). */
  contract: string;
  profile: BudgetProfile;
}

/** Compose the first user message: contract, then the task. */
export function taskBrief(contract: string, task: string): string {
  return `${contract}\n\nTask: ${task}`;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  contract: [
    "You are a coding agent working in a git repository.",
    "Rules: read before editing; make minimal changes; run tests after changes; verify before claiming done.",
    "Tool results may be truncated — a `[truncated]` marker means more exists; re-read a narrower range.",
    "History may be evicted at reset; files on disk are authoritative.",
    "Act, don't narrate.",
    "Keep outputs short.",
  ].join("\n"),
  profile: DEFAULT_PROFILE,
};
