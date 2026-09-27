import { serve } from "@hono/node-server";
import { createAnvil } from "./anvil.ts";
import { config } from "./config.ts";
import { startMonitorScheduler } from "./routes/monitor.ts";
import { createResourceServer } from "./x402.ts";

const app = await createAnvil(config.PAY_TO ? createResourceServer() : undefined);
startMonitorScheduler();
serve({ fetch: app.fetch, port: config.PORT }, (info) => console.log(`Anvil listening on :${info.port}`));
