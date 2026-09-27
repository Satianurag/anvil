import type { x402ResourceServer } from "@x402/core/server";
import { createApp } from "./app.ts";
import { buildTools, mcpHandler } from "./mcp.ts";
import { jobs } from "./routes/index.ts";
import { monitorStatus } from "./routes/monitor.ts";

/** Full Anvil HTTP app: paid job routes, verification, MCP endpoint and monitor status. */
export async function createAnvil(resourceServer?: x402ResourceServer) {
  const mcp = mcpHandler(await buildTools(jobs, resourceServer));
  return createApp(jobs, resourceServer, (app) => {
    app.all("/mcp", (c) => mcp(c.req.raw));
    app.get("/v1/monitor/:id", async (c) => {
      const status = await monitorStatus(c.req.param("id"));
      return status ? c.json(status) : c.json({ error: "unknown_monitor" }, 404);
    });
  });
}
