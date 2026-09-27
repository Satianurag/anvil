import { randomUUID } from "node:crypto";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { config } from "./config.ts";
import { anchorReceipt, lookupTransaction, NOTE_PREFIX, paymentTxId, type ReceiptNote } from "./lib/chain.ts";
import { type JobDefinition, JobInputError } from "./lib/job.ts";
import { UnsafeTargetError } from "./lib/ssrf.ts";
import { getObject, putObject, sha256, signedUrl } from "./lib/storage.ts";
import { CHALLENGE_TAG, paidRoutes } from "./x402.ts";

interface Receipt {
  job_id: string;
  route: string;
  manifest_sha256: string;
  payment_txid: string;
  anchor_txid?: string;
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

async function readJson<T>(key: string): Promise<T | undefined> {
  const bytes = await getObject(key);
  return bytes && (JSON.parse(new TextDecoder().decode(bytes)) as T);
}

export function createApp(jobs: JobDefinition[], resourceServer?: x402ResourceServer) {
  const app = new Hono();
  const pending = new Map<string, Receipt>();

  if (resourceServer && config.PAY_TO) {
    resourceServer.onAfterSettle(async ({ result }) => {
      const receipt = pending.get(result.transaction);
      if (!receipt) return;
      pending.delete(result.transaction);
      if (config.RECEIPT_MNEMONIC) {
        const note: ReceiptNote = { p: receipt.payment_txid, h: receipt.manifest_sha256, r: receipt.route };
        receipt.anchor_txid = await anchorReceipt(note).catch((err) => {
          console.error("receipt anchor failed", err);
          return undefined;
        });
      }
      await putObject(`receipts/${receipt.payment_txid}.json`, json(receipt), "application/json");
    });
    app.use(paymentMiddleware(paidRoutes(jobs, config.PAY_TO), resourceServer));
  } else {
    console.warn("PAY_TO not configured: paid routes run WITHOUT payment (development only)");
  }

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    if (err instanceof JobInputError || err instanceof UnsafeTargetError)
      return c.json({ error: "invalid_input", message: err.message }, 422);
    console.error(err);
    return c.json({ error: "job_failed", message: err instanceof Error ? err.message : String(err) }, 500);
  });

  app.get("/", (c) =>
    c.json({
      service: "Anvil",
      network: config.network,
      payTo: config.PAY_TO ?? null,
      tag: CHALLENGE_TAG,
      routes: jobs.map((j) => ({ method: "POST", path: j.path, price: j.price, description: j.description })),
    }),
  );
  app.get("/healthz", (c) => c.text("ok"));

  for (const job of jobs) {
    app.post(job.path, async (c) => {
      const raw = await c.req.json().catch(() => {
        throw new JobInputError("body must be JSON");
      });
      const parsed = job.input.safeParse(raw);
      if (!parsed.success) return c.json({ error: "invalid_input", issues: parsed.error.issues }, 422);

      const output = await job.run(parsed.data, AbortSignal.timeout(job.timeoutMs ?? 120_000));
      const jobId = randomUUID();
      const header = c.req.header("PAYMENT-SIGNATURE");
      const payTxId = header ? paymentTxId(decodePaymentSignatureHeader(header)) : undefined;

      const artifacts = await Promise.all(
        (output.artifacts ?? []).map(async (a) => {
          const key = `jobs/${jobId}/${a.name}`;
          await putObject(key, a.body, a.contentType);
          return {
            name: a.name,
            content_type: a.contentType,
            bytes: typeof a.body === "string" ? Buffer.byteLength(a.body) : a.body.byteLength,
            sha256: sha256(a.body),
            key,
          };
        }),
      );
      const manifest = {
        version: "anvil/v1",
        job_id: jobId,
        route: job.path,
        created_at: new Date().toISOString(),
        request_sha256: sha256(JSON.stringify(raw)),
        result_sha256: sha256(JSON.stringify(output.result)),
        payment: payTxId ? { txid: payTxId, network: config.network, pay_to: config.PAY_TO, price: job.price } : null,
        artifacts: artifacts.map(({ key: _key, ...a }) => a),
      };
      const manifestBody = json(manifest);
      const manifestSha = sha256(manifestBody);
      await putObject(`jobs/${jobId}/manifest.json`, manifestBody, "application/json");
      if (payTxId)
        pending.set(payTxId, { job_id: jobId, route: job.path, manifest_sha256: manifestSha, payment_txid: payTxId });

      return c.json({
        job_id: jobId,
        result: output.result,
        artifacts: await Promise.all(artifacts.map(async ({ key, ...a }) => ({ ...a, url: await signedUrl(key) }))),
        manifest: { sha256: manifestSha, url: await signedUrl(`jobs/${jobId}/manifest.json`) },
        receipt: payTxId
          ? { payment_txid: payTxId, verify_url: new URL(`/v1/verify/${payTxId}`, config.PUBLIC_URL).href }
          : null,
      });
    });
  }

  app.get("/v1/verify/:txid", async (c) => {
    const txid = c.req.param("txid");
    if (!/^[A-Z2-7]{52}$/.test(txid)) return c.json({ error: "invalid_txid" }, 400);
    const receipt = await readJson<Receipt>(`receipts/${txid}.json`);
    if (!receipt) return c.json({ verified: false, reason: "unknown_payment" }, 404);
    const manifestBytes = await getObject(`jobs/${receipt.job_id}/manifest.json`);
    const manifestOk = !!manifestBytes && sha256(manifestBytes) === receipt.manifest_sha256;

    let anchor: { txid: string; round?: number; note_matches: boolean } | null = null;
    if (receipt.anchor_txid) {
      const tx = await lookupTransaction(receipt.anchor_txid);
      const note = tx.note ? new TextDecoder().decode(tx.note) : "";
      const parsed = note.startsWith(NOTE_PREFIX)
        ? (JSON.parse(note.slice(NOTE_PREFIX.length)) as ReceiptNote)
        : undefined;
      anchor = {
        txid: receipt.anchor_txid,
        round: tx.confirmedRound === undefined ? undefined : Number(tx.confirmedRound),
        note_matches: parsed?.p === txid && parsed.h === receipt.manifest_sha256 && parsed.r === receipt.route,
      };
    }
    return c.json({
      verified: manifestOk && (anchor?.note_matches ?? false),
      payment_txid: txid,
      route: receipt.route,
      job_id: receipt.job_id,
      manifest_sha256: receipt.manifest_sha256,
      manifest_intact: manifestOk,
      manifest_url: await signedUrl(`jobs/${receipt.job_id}/manifest.json`),
      anchor,
    });
  });

  return app;
}
