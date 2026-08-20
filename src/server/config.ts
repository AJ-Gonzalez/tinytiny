/**
 * llama-server process configuration.
 *
 * Defaults are the measured profile for this machine and the Ornith-1.5-9B
 * Q4_K_M GGUF (see DESIGN.md "Model and hardware envelope"). Anything a user
 * flips (model path, port) is overridable via env; the rest stay at the
 * measured values by design — they are benchmarks, not tuning knobs.
 */

export interface LlamaServerConfig {
  /** Path to the GGUF model file. */
  modelPath: string;
  /** llama-server binary. */
  bin: string;
  host: string;
  port: number;
  /** Context size, tokens. 32K per the budget design. */
  ctxSize: number;
  /** KV cache quantizations (q8_0 measured: 64 KiB/token). */
  cacheTypeK: "q8_0";
  cacheTypeV: "q8_0";
  /** Single slot: one request at a time, strict-extension history. */
  parallel: 1;
  threads: number;
  /** Reasoning budget cap; `--reasoning off` disables (see LESSONS.md). */
  reasoningBudget: number;
  reasoningFormat: "deepseek";
}

export const DEFAULT_CONFIG: LlamaServerConfig = {
  modelPath: process.env.TINYTINY_MODEL ??
    // Official Ornith-1.5-9B Q4_K_M GGUF, as cached by Ollama.
    "/home/alicia/.ollama/models/blobs/sha256-852922174ee4f76621df26105333f1dfe2171cdfb60ebe5a4b013836681a8a77",
  bin: process.env.TINYTINY_LLAMA_BIN ?? "llama-server",
  host: "127.0.0.1",
  port: Number(process.env.TINYTINY_PORT ?? 18081),
  ctxSize: 32768,
  cacheTypeK: "q8_0",
  cacheTypeV: "q8_0",
  parallel: 1,
  threads: 8,
  reasoningBudget: 512,
  reasoningFormat: "deepseek",
};

/** Build the argv for llama-server from a config. Order is stable. */
export function buildArgs(cfg: LlamaServerConfig): string[] {
  return [
    "-m", cfg.modelPath,
    "-t", String(cfg.threads),
    "--ctx-size", String(cfg.ctxSize),
    "--cache-type-k", cfg.cacheTypeK,
    "--cache-type-v", cfg.cacheTypeV,
    "--parallel", String(cfg.parallel),
    "--reasoning-budget", String(cfg.reasoningBudget),
    "--reasoning-format", cfg.reasoningFormat,
    "--host", cfg.host,
    "--port", String(cfg.port),
    "--jinja",
  ];
}
