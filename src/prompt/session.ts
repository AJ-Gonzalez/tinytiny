/**
 * Session configuration: system prompt + context-budget profile.
 * Budget profiles are carried here and enforced by the eviction logic in M3;
 * they are data now so the default and conservative presets are explicit.
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
  systemPrompt: string;
  profile: BudgetProfile;
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  systemPrompt: [
    "You are a coding agent working in a git repository.",
    "Rules: read before editing; make minimal changes; run tests after changes; verify before claiming done.",
    "Tool results may be truncated — a `[truncated]` marker means more exists; re-read a narrower range.",
    "History may be evicted at reset; files on disk are authoritative.",
    "Act, don't narrate.",
    "Keep outputs short.",
  ].join("\n"),
  profile: DEFAULT_PROFILE,
};
