#!/usr/bin/env node
/**
 * Stand-in for llama-server used by the fast test suite.
 * Mimics the real server's CLI shape (accepts `--port`) and readiness
 * log line, so the wrapper under test needs no seams.
 *
 * Modes via FAKE_MODE:
 *   ready  - bind the port, print the ready line, exit 0 on SIGTERM
 *   never  - print a "warming up" line but never become ready
 *   fail   - print an error to stderr and exit 1
 *   hang   - become ready but ignore SIGTERM (exercises the SIGKILL path)
 */
import net from "node:net";

const portIdx = process.argv.indexOf("--port");
const port = portIdx !== -1 ? Number(process.argv[portIdx + 1]) : 18099;
const mode = process.env.FAKE_MODE ?? "ready";

const server = net.createServer((sock) => sock.end());
server.listen(port, "127.0.0.1", () => {
  if (mode === "ready" || mode === "hang") {
    console.log(`llama-server listening on http://127.0.0.1:${port}`);
  } else if (mode === "never") {
    console.log("llama-server: warming up (never ready)");
  } else if (mode === "fail") {
    console.error("llama-server: error loading model");
    server.close();
    process.exit(1);
  }
});

process.on("SIGTERM", () => {
  if (mode === "hang") return; // ignore SIGTERM; only SIGKILL works
  server.close();
  process.exit(0);
});
