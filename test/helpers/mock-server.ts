/**
 * Minimal OpenAI-compatible mock server for client tests.
 * Records request bodies; handler returns JSON or SSE frames per request.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface MockReply {
  status?: number;
  json?: unknown;
  /** SSE frames, written verbatim (`data: ...` + blank line expected). */
  sse?: string[];
  /** Delay the reply by this many ms (deterministic abort tests). */
  delayMs?: number;
}

export interface MockCompletions {
  url: string;
  bodies: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export function startMockCompletions(
  handler: (body: Record<string, unknown>, count: number) => MockReply,
): Promise<MockCompletions> {
  const bodies: Array<Record<string, unknown>> = [];
  let count = 0;

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // keep empty; handler decides
      }
      bodies.push(body);
      const reply = handler(body, ++count);
      const send = (): void => {
        if (reply.sse !== undefined) {
          res.writeHead(reply.status ?? 200, { "Content-Type": "text/event-stream" });
          for (const frame of reply.sse) res.write(frame);
          res.end();
          return;
        }
        res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply.json ?? {}));
      };
      if (reply.delayMs !== undefined) setTimeout(send, reply.delayMs);
      else send();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        bodies,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
