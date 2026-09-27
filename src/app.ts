import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { config } from "./config.ts";
import { paymentTxId } from "./lib/chain.ts";
import { type JobDefinition, JobInputError } from "./lib/job.ts";
import { executeJob, lookupHash, precheck, recordSettlement, verifyReceipt } from "./lib/receipts.ts";
import { UnsafeTargetError } from "./lib/ssrf.ts";
import { CHALLENGE_TAG, paidRoutes } from "./x402.ts";

export function createApp(jobs: JobDefinition[], resourceServer?: x402ResourceServer, extra?: (app: Hono) => void) {
  const app = new Hono();

  for (const job of jobs)
    app.post(job.path, async (c, next) => {
      await precheck(job, await c.req.json().catch(() => Promise.reject(new JobInputError("body must be JSON"))));
      await next();
    });

  if (resourceServer && config.PAY_TO) {
    resourceServer.onAfterSettle(({ result }) => recordSettlement(result.transaction));
    app.use(paymentMiddleware(paidRoutes(jobs, config.PAY_TO), resourceServer));
  } else {
    console.warn("PAY_TO not configured: paid routes run WITHOUT payment (development only)");
  }

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof JobInputError || err instanceof UnsafeTargetError)
      return c.json({ error: "invalid_input", message: err.message, issues: (err as JobInputError).details }, 422);
    console.error(err);
    return c.json({ error: "job_failed", message: err instanceof Error ? err.message : String(err) }, 500);
  });

  app.get("/", (c) =>
    c.json({
      service: "Anvil",
      network: config.network,
      payTo: config.PAY_TO ?? null,
      tag: CHALLENGE_TAG,
      mcp: new URL("/mcp", config.PUBLIC_URL).href,
      routes: jobs.map((j) => ({ method: "POST", path: j.path, price: j.price, description: j.description })),
    }),
  );
  app.get("/healthz", (c) => c.text("ok"));

  for (const job of jobs) {
    app.post(job.path, async (c) => {
      const raw = await c.req.json().catch(() => {
        throw new JobInputError("body must be JSON");
      });
      const header = c.req.header("PAYMENT-SIGNATURE");
      return c.json(await executeJob(job, raw, header ? paymentTxId(decodePaymentSignatureHeader(header)) : undefined));
    });
  }

  app.get("/v1/verify/hash/:sha256", async (c) => {
    const hash = c.req.param("sha256").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) return c.json({ error: "invalid_sha256" }, 400);
    const jobs = await lookupHash(hash);
    return c.json({ sha256: hash, found: jobs.length > 0, jobs }, jobs.length ? 200 : 404);
  });

  app.get("/v1/verify/:txid", async (c) => {
    const txid = c.req.param("txid");
    if (!/^[A-Z2-7]{52}$/.test(txid)) return c.json({ error: "invalid_txid" }, 400);
    const result = await verifyReceipt(txid);
    return result ? c.json(result) : c.json({ verified: false, reason: "unknown_payment" }, 404);
  });

  extra?.(app);
  return app;
}
