/**
 * Shared request helper for the live scripts. With LIVE_PAYER_MNEMONIC set (plus PAY_TO, RECEIPT_MNEMONIC and
 * ALGORAND_NETWORK), every call is paid through the configured facilitator and its on-chain receipt is verified.
 */
import assert from "node:assert/strict";
import { toClientAvmSigner } from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import algosdk from "algosdk";

const mnemonic = process.env.LIVE_PAYER_MNEMONIC;
if (!mnemonic) delete process.env.PAY_TO;
const { createAnvil } = await import("../src/anvil.ts");
const { config } = await import("../src/config.ts");
const { createResourceServer } = await import("../src/x402.ts");
const { sha256 } = await import("../src/lib/storage.ts");
export const app = await createAnvil(mnemonic ? createResourceServer() : undefined);

const local = (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(app.request(input, init));
const doFetch = mnemonic
  ? wrapFetchWithPayment(
      local as typeof fetch,
      x402Client.fromConfig({
        schemes: [
          {
            network: config.network,
            client: new ExactAvmScheme(
              toClientAvmSigner(Buffer.from(algosdk.mnemonicToSecretKey(mnemonic).sk).toString("base64")),
              { algodUrl: config.algodUrl },
            ),
          },
        ],
        spendControls: { allowedAssets: true },
      }),
    )
  : local;

async function verifyReceipt(txid: string) {
  for (let i = 0; i < 30; i++) {
    const res = await app.request(`/v1/verify/${txid}`);
    if (res.ok && ((await res.json()) as { verified: boolean }).verified) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  assert.fail(`receipt for ${txid} not verified`);
}

// biome-ignore lint/suspicious/noExplicitAny: loose JSON assertions in live scripts
export async function post(path: string, body: unknown): Promise<any> {
  const t = Date.now();
  const res = await doFetch(`${config.PUBLIC_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // biome-ignore lint/suspicious/noExplicitAny: loose JSON assertions in live scripts
  const json = (await res.json()) as any;
  const why = res.headers.get("PAYMENT-REQUIRED");
  assert.equal(
    res.status,
    200,
    `${path}: ${JSON.stringify(json).slice(0, 800)} ${why ? JSON.stringify(decodePaymentRequiredHeader(why).error) : ""} ${res.headers.get("PAYMENT-RESPONSE") ? JSON.stringify(decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE") ?? "")) : ""}`,
  );
  for (const a of json.artifacts) {
    const bytes = new Uint8Array(await (await fetch(a.url)).arrayBuffer());
    assert.equal(sha256(bytes), a.sha256, `${path} ${a.name} hash`);
  }
  let paid = "";
  if (mnemonic) {
    const settle = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE") ?? "");
    assert.ok(settle.success, `${path} not settled`);
    assert.equal(json.receipt.payment_txid, settle.transaction);
    await verifyReceipt(settle.transaction);
    paid = ` paid ${settle.transaction}`;
  }
  console.log(`OK ${path} ${Date.now() - t}ms${paid}`, json.artifacts.map((a: { name: string }) => a.name).join(" "));
  return json;
}
