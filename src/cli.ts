#!/usr/bin/env node
/**
 * TinyTiny CLI. M0 exposes one real command: `serve` — spawn llama-server,
 * wait until healthy, report, and stop cleanly on SIGINT/SIGTERM. The full
 * agent TUI arrives in M4; this is the machine-check tool in the meantime.
 */

import { DEFAULT_CONFIG } from "./server/config.ts";
import { LlamaServer } from "./server/llama-server.ts";

function usage(): void {
  console.error("Usage: tinytiny serve");
  process.exit(1);
}

async function serve(): Promise<void> {
  const server = new LlamaServer(DEFAULT_CONFIG);
  console.error(`starting llama-server (model: ${DEFAULT_CONFIG.modelPath})`);
  await server.start();
  console.error(`ready at ${server.baseUrl} — Ctrl+C to stop`);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  await server.stop();
  // llama-server exits 1 on SIGTERM; a harness-initiated stop is graceful — exit 0.
  process.exit(0);
}

const [cmd] = process.argv.slice(2);
switch (cmd) {
  case "serve":
    void serve().catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
    break;
  default:
    usage();
}
