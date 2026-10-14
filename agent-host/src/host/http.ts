// Loopback health surface. `/health` always answers with the full state (liveness for the
// supervisor, alerts for the operator); `/ready` answers 503 until the gateway can reach every
// routed provider and the Worker answered a recent poll.

import { createServer, type Server } from "node:http";
import type { HostStatus } from "./service.ts";

export function createHealthServer(status: () => Promise<HostStatus>): Server {
  return createServer(async (request, response) => {
    const path = (request.url ?? "/").split("?")[0];
    if (request.method !== "GET" || (path !== "/health" && path !== "/ready")) {
      response.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    try {
      const current = await status();
      const code = path === "/ready" && !current.ready ? 503 : 200;
      response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(
        JSON.stringify({
          ready: current.ready,
          alerts: current.alerts,
          worker: {
            reachable: current.workerReachable,
            last_contact_at: current.lastWorkerContactAt,
            last_poll_error: current.lastPollError,
          },
          in_flight: current.inFlight,
          backlog: current.backlog,
          providers: current.gateway.providers,
          usage: current.gateway.usage,
        }),
      );
    } catch {
      response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: "health_unavailable" }));
    }
  });
}
