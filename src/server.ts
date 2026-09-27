import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { config } from "./config.ts";
import { jobs } from "./routes/index.ts";
import { createResourceServer } from "./x402.ts";

const app = createApp(jobs, config.PAY_TO ? createResourceServer() : undefined);
serve({ fetch: app.fetch, port: config.PORT }, (info) => console.log(`Anvil listening on :${info.port}`));
