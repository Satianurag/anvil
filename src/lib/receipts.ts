import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import { anchorReceipt, lookupTransaction, NOTE_PREFIX, type ReceiptNote } from "./chain.ts";
import { type JobDefinition, JobInputError } from "./job.ts";
import { assertPublicUrl } from "./ssrf.ts";
import { assertCapacity, getJson, getObject, listKeys, putJson, putObject, sha256, signedUrl } from "./storage.ts";

interface Receipt {
  job_id: string;
  route: string;
  manifest_sha256: string;
  payment_txid: string;
  anchor_txid?: string;
}

const pending = new Map<string, Receipt>();
const settled = new Set<string>();
const publicUrl = (path: string) => new URL(path, config.PUBLIC_URL).href;

const urlsIn = (v: unknown): string[] =>
  v && typeof v === "object"
    ? Object.entries(v).flatMap(([k, x]) => (k === "url" && typeof x === "string" ? [x] : urlsIn(x)))
    : [];

/** Schema + SSRF checks that run before payment, so malformed or unsafe requests are never charged. */
export async function precheck(job: JobDefinition, raw: unknown) {
  const parsed = job.input.safeParse(raw);
  if (!parsed.success) throw new JobInputError("invalid input", parsed.error.issues);
  await Promise.all([...urlsIn(parsed.data).map(assertPublicUrl), assertCapacity()]);
  return parsed.data;
}

/** Validates input, runs the job, stores + hashes artifacts and the manifest. Throws JobInputError for caller errors. */
export async function executeJob(job: JobDefinition, raw: unknown, payTxId?: string) {
  const output = await job.run(await precheck(job, raw), AbortSignal.timeout(job.timeoutMs ?? 120_000));
  const jobId = randomUUID();

  const artifacts = await Promise.all(
    (output.artifacts ?? []).map(async (a) => {
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
    pending.set(payTxId, { job_id: jobId, route: job.path, manifest_sha256: manifestSha, payment_txid: payTxId });
    if (settled.delete(payTxId)) void recordSettlement(payTxId).catch((err) => console.error("receipt failed", err));
  }

  return {
    job_id: jobId,
    result: output.result,
    artifacts: await Promise.all(artifacts.map(async ({ key, ...a }) => ({ ...a, url: await signedUrl(key) }))),
    manifest: { sha256: manifestSha, url: await signedUrl(`jobs/${jobId}/manifest.json`) },
    receipt: payTxId ? { payment_txid: payTxId, verify_url: publicUrl(`/v1/verify/${payTxId}`) } : null,
  };
}

/** Called on settlement (before or after the job): anchors the manifest hash (if a receipt key is configured) and stores the receipt. */
export async function recordSettlement(payTxId: string) {
  const receipt = pending.get(payTxId);
  if (!receipt) {
    settled.add(payTxId);
    return;
  }
  pending.delete(payTxId);
  if (config.RECEIPT_MNEMONIC) {
    const note: ReceiptNote = { p: receipt.payment_txid, h: receipt.manifest_sha256, r: receipt.route };
    receipt.anchor_txid = await anchorReceipt(note).catch((err) => {
      console.error("receipt anchor failed", err);
      return undefined;
    });
  }
  await putJson(`receipts/${receipt.payment_txid}.json`, receipt);
}

export async function verifyReceipt(txid: string) {
  const receipt = await getJson<Receipt>(`receipts/${txid}.json`);
  if (!receipt) return undefined;
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
