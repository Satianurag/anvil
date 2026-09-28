import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import { anchorReceipt, lookupTransaction, NOTE_PREFIX, type ReceiptNote } from "./chain.ts";
import { type Artifact, type JobDefinition, JobInputError } from "./job.ts";
import { assertPublicUrl } from "./ssrf.ts";
import { assertCapacity, getJson, getObject, listKeys, putJson, putObject, sha256, signedUrl } from "./storage.ts";

interface Receipt {
  status: "completed" | "failed";
  job_id: string | null;
  route: string;
  manifest_sha256: string | null;
  payment_txid: string;
  anchor_txid?: string;
  error?: string;
}

const pending = new Map<string, Receipt>();
const settled = new Set<string>();
const inFlight = new Set<string>();
const publicUrl = (path: string) => new URL(path, config.PUBLIC_URL).href;

const urlsIn = (v: unknown): string[] =>
  v && typeof v === "object"
    ? Object.entries(v).flatMap(([k, x]) =>
        (k === "url" || k.endsWith("_url")) && typeof x === "string" ? [x] : urlsIn(x),
      )
    : [];

/** Schema + SSRF checks that run before payment, so malformed or unsafe requests are never charged. */
export async function precheck(job: JobDefinition, raw: unknown) {
  const parsed = job.input.safeParse(raw);
  if (!parsed.success) throw new JobInputError("invalid input", parsed.error.issues);
  await Promise.all([...urlsIn(parsed.data).map(assertPublicUrl), assertCapacity()]);
  return parsed.data;
}

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|xhtml))/;

/** Enforces the per-artifact byte cap: textual bodies are truncated, oversized binaries dropped. */
function capArtifact(a: Artifact): Artifact | undefined {
  const bytes = typeof a.body === "string" ? Buffer.byteLength(a.body) : a.body.byteLength;
  if (bytes <= config.MAX_ARTIFACT_BYTES) return a;
  if (TEXTUAL.test(a.contentType)) {
    const body =
      typeof a.body === "string"
        ? a.body.slice(0, config.MAX_ARTIFACT_BYTES)
        : a.body.slice(0, config.MAX_ARTIFACT_BYTES);
    return { ...a, body };
  }
  console.warn(`artifact ${a.name} (${bytes}B) exceeds MAX_ARTIFACT_BYTES, dropped`);
  return undefined;
}

/** Validates input, runs the job, stores + hashes artifacts and the manifest. Throws JobInputError for caller errors. */
export async function executeJob(job: JobDefinition, raw: unknown, payTxId?: string) {
  if (payTxId) {
    // Replay guard: one settled payment buys one job. The facilitator is expected to reject re-settled
    // txids, but a replayed PAYMENT-SIGNATURE that slips through must never run a second job.
    if (inFlight.has(payTxId) || (await getJson(`receipts/${payTxId}.json`)))
      throw new JobInputError("payment already consumed", [{ message: `txid ${payTxId} already has a receipt` }]);
    inFlight.add(payTxId);
  }
  try {
    const output = await job.run(await precheck(job, raw), AbortSignal.timeout(job.timeoutMs ?? 120_000));
    const jobId = randomUUID();

    const artifacts = await Promise.all(
      (output.artifacts ?? [])
        .flatMap((a) => {
          const capped = capArtifact(a);
          return capped ? [capped] : [];
        })
        .map(async (a) => {
          const key = `jobs/${jobId}/${a.name}`;
          await putObject(key, a.body, a.contentType);
          const bytes = typeof a.body === "string" ? Buffer.byteLength(a.body) : a.body.byteLength;
          return { name: a.name, content_type: a.contentType, bytes, sha256: sha256(a.body), key };
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
    const manifestBody = JSON.stringify(manifest, null, 2);
    const manifestSha = sha256(manifestBody);
    await putObject(`jobs/${jobId}/manifest.json`, manifestBody, "application/json");
    const hashes = new Set([...artifacts.map((a) => a.sha256), ...(output.index ?? []), manifestSha]);
    await Promise.all(
      [...hashes].map((h) =>
        putJson(`index/${h}/${jobId}.json`, { job_id: jobId, route: job.path, payment_txid: payTxId }),
      ),
    );
    if (payTxId) {
      pending.set(payTxId, {
        status: "completed",
        job_id: jobId,
        route: job.path,
        manifest_sha256: manifestSha,
        payment_txid: payTxId,
      });
      if (settled.delete(payTxId)) void recordSettlement(payTxId).catch((err) => console.error("receipt failed", err));
    }

    return {
      job_id: jobId,
      result: output.result,
      artifacts: await Promise.all(artifacts.map(async ({ key, ...a }) => ({ ...a, url: await signedUrl(key) }))),
      manifest: { sha256: manifestSha, url: await signedUrl(`jobs/${jobId}/manifest.json`) },
      receipt: payTxId ? { payment_txid: payTxId, verify_url: publicUrl(`/v1/verify/${payTxId}`) } : null,
    };
  } catch (err) {
    // A settled payment that fails mid-job still gets a durable receipt so /v1/verify explains it.
    if (payTxId)
      await putJson(`receipts/${payTxId}.json`, {
        status: "failed",
        job_id: null,
        route: job.path,
        manifest_sha256: null,
        payment_txid: payTxId,
        error: (err as Error).message?.split("\n")[0],
      } satisfies Receipt).catch((e) => console.error("failed-job receipt write failed", e));
    throw err;
  } finally {
    if (payTxId) inFlight.delete(payTxId);
  }
}

const ANCHOR_BACKOFF_MS = [2_000, 8_000, 20_000];

async function anchorWithRetry(note: ReceiptNote) {
  for (let i = 0; i <= ANCHOR_BACKOFF_MS.length; i++) {
    try {
      return await anchorReceipt(note);
    } catch (err) {
      if (i === ANCHOR_BACKOFF_MS.length) {
        console.error("receipt anchor failed after retries", err);
        return undefined;
      }
      console.warn(`receipt anchor attempt ${i + 1} failed, retrying`, (err as Error).message);
      await new Promise((r) => setTimeout(r, ANCHOR_BACKOFF_MS[i]));
    }
  }
}

/** Called on settlement (before or after the job): anchors the manifest hash (if a receipt key is configured) and stores the receipt. */
export async function recordSettlement(payTxId: string) {
  const receipt = pending.get(payTxId);
  if (!receipt) {
    settled.add(payTxId);
    // Persist the settle event now, so a crash before the job finishes still leaves a verifiable trail.
    await putJson(`receipts/${payTxId}.pending.json`, {
      payment_txid: payTxId,
      status: "settled_awaiting_job",
      settled_at: new Date().toISOString(),
    }).catch((err) => console.error("settle marker write failed", err));
    return;
  }
  pending.delete(payTxId);
  if (config.RECEIPT_MNEMONIC && receipt.manifest_sha256) {
    const note: ReceiptNote = { p: receipt.payment_txid, h: receipt.manifest_sha256, r: receipt.route };
    receipt.anchor_txid = await anchorWithRetry(note);
  }
  await putJson(`receipts/${receipt.payment_txid}.json`, receipt);
}

export async function verifyReceipt(txid: string) {
  const receipt = await getJson<Receipt>(`receipts/${txid}.json`);
  if (!receipt) {
    const marker = await getJson<{ payment_txid: string; status: string; settled_at: string }>(
      `receipts/${txid}.pending.json`,
    );
    if (!marker) return undefined;
    return {
      verified: false,
      status: "settled_awaiting_job" as const,
      payment_txid: txid,
      settled_at: marker.settled_at,
    };
  }
  if (receipt.status === "failed")
    return {
      verified: false,
      status: "failed" as const,
      payment_txid: txid,
      route: receipt.route,
      error: receipt.error,
    };
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
  return {
    verified: manifestOk && (anchor?.note_matches ?? false),
    status: "completed" as const,
    payment_txid: txid,
    route: receipt.route,
    job_id: receipt.job_id,
    manifest_sha256: receipt.manifest_sha256,
    manifest_intact: manifestOk,
    manifest_url: await signedUrl(`jobs/${receipt.job_id}/manifest.json`),
    anchor,
  };
}

/** Jobs whose manifest, artifacts or attested hashes include this SHA-256. */
export async function lookupHash(hash: string) {
  const keys = await listKeys(`index/${hash}/`);
  const entries = await Promise.all(
    keys.map((k) => getJson<{ job_id: string; route: string; payment_txid?: string }>(k)),
  );
  return Promise.all(
    entries
      .filter((e) => e !== undefined)
      .map(async (e) => ({
        ...e,
        manifest_url: await signedUrl(`jobs/${e.job_id}/manifest.json`),
        verify_url: e.payment_txid ? publicUrl(`/v1/verify/${e.payment_txid}`) : null,
      })),
  );
}
