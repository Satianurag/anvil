import { serve } from "@hono/node-server";
import { createAnvil } from "./anvil.ts";
import { config } from "./config.ts";
import { startMonitorScheduler } from "./routes/monitor.ts";
import { createResourceServer } from "./x402.ts";

const app = await createAnvil(config.PAY_TO ? createResourceServer() : undefined);
const monitorTimer = startMonitorScheduler();
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) =>
  console.log(`Anvil listening on :${info.port}`),
);

let closing = false;
const shutdown = (signal: string) => {
  if (closing) return;
  closing = true;
  console.log(`${signal} received: stopping monitor scheduler and draining in-flight requests`);
  clearInterval(monitorTimer);
  // server.close() stops accepting new connections and resolves once open ones finish.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 15_000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
