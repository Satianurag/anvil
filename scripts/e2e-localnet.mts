/**
 * Full paid round-trip on AlgoKit LocalNet with an in-process exact-AVM facilitator:
 * 402 challenge -> signed USDC payment -> job -> settlement -> on-chain receipt -> /v1/verify.
 * Requires: `algokit localnet start` and `docker compose --profile dev up -d`.
 */
import assert from "node:assert/strict";
import { AlgorandClient, algo } from "@algorandfoundation/algokit-utils";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ALGORAND_TESTNET_CAIP2, toClientAvmSigner, toFacilitatorAvmSigner } from "@x402/avm";
import { ExactAvmScheme as AvmClient } from "@x402/avm/exact/client";
import { ExactAvmScheme as AvmFacilitator } from "@x402/avm/exact/facilitator";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { wrapMCPClientWithPayment } from "@x402/mcp";
import algosdk from "algosdk";

const ALGOD = "http://localhost:4001";
const TOKEN = "a".repeat(64);
const NETWORK = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const algorand = AlgorandClient.defaultLocalNet();
const dispenser = await algorand.account.localNetDispenser();

const newAccount = async (fund = 10) => {
  const acct = algosdk.generateAccount();
  algorand.setSignerFromAccount(acct);
  await algorand.send.payment({ sender: dispenser.addr, receiver: acct.addr, amount: algo(fund) });
  return acct;
};
const b64 = (a: algosdk.Account) => Buffer.from(a.sk).toString("base64");

const [payTo, payer, feePayer, receipts] = await Promise.all([newAccount(), newAccount(), newAccount(), newAccount()]);
const { assetId } = await algorand.send.assetCreate({
  sender: dispenser.addr,
  total: 10n ** 15n,
  decimals: 6,
  unitName: "USDC",
  assetName: "Local USDC",
});
for (const a of [payTo, payer]) await algorand.send.assetOptIn({ sender: a.addr, assetId });
await algorand.send.assetTransfer({ sender: dispenser.addr, receiver: payer.addr, assetId, amount: 5_000_000n });
const usdc = async (a: algosdk.Account) => (await algorand.asset.getAccountInformation(a.addr, assetId)).balance;

Object.assign(process.env, {
  ALGORAND_NETWORK: "testnet",
  ALGOD_URL: ALGOD,
  ALGOD_TOKEN: TOKEN,
  INDEXER_URL: "http://localhost:8980",
  USDC_ASA: assetId.toString(),
  PAY_TO: payTo.addr.toString(),
  RECEIPT_MNEMONIC: algosdk.secretKeyToMnemonic(receipts.sk),
  PUBLIC_URL: "http://localhost:4031",
});
const { createAnvil } = await import("../src/anvil.ts");
const { createResourceServer } = await import("../src/x402.ts");

const facilitator = new x402Facilitator().register(
  [NETWORK, ALGORAND_TESTNET_CAIP2],
  new AvmFacilitator(toFacilitatorAvmSigner(b64(feePayer), { testnetUrl: ALGOD, algodToken: TOKEN })),
);
const app = await createAnvil(
  createResourceServer({
    verify: facilitator.verify.bind(facilitator),
    settle: facilitator.settle.bind(facilitator),
    // Mirror GoPlausible, which advertises the full-genesis-hash CAIP-2 id.
    getSupported: async () => {
      const supported = facilitator.getSupported() as Awaited<ReturnType<FacilitatorClient["getSupported"]>>;
      return { ...supported, kinds: supported.kinds.map((k) => ({ ...k, network: NETWORK })) };
    },
  }),
);
const server = serve({ fetch: app.fetch, port: 4031 });
const base = "http://localhost:4031";
const body = JSON.stringify({ url: "https://example.com" });
const headers = { "content-type": "application/json" };

try {
  // 1. Unpaid request -> 402 with challenge tag + Bazaar metadata
  const unpaid = await fetch(`${base}/v1/evidence`, { method: "POST", headers, body });
  assert.equal(unpaid.status, 402);
  const required = decodePaymentRequiredHeader(unpaid.headers.get("PAYMENT-REQUIRED") ?? "");
  const req = required.accepts[0];
  assert.equal(req.extra?.tag, "x402-global-challenge");
  assert.equal(req.amount, "350000");
  assert.equal(req.asset, assetId.toString());
  assert.equal(req.extra?.feePayer, feePayer.addr.toString());
  assert.ok(required.extensions?.bazaar, "bazaar extension present");
  console.log("402 challenge OK", JSON.stringify(required.extensions?.bazaar).slice(0, 160));

  const client = x402Client.fromConfig({
    schemes: [
      {
        network: NETWORK,
        client: new AvmClient(toClientAvmSigner(b64(payer)), { algodUrl: ALGOD, algodToken: TOKEN }),
      },
    ],
    spendControls: { allowedAssets: true },
  });
  const paidFetch = wrapFetchWithPayment(fetch, client);

  // 2. Invalid input with payment -> 422 and NOT settled
  const before = await usdc(payTo);
  const bad = await paidFetch(`${base}/v1/evidence`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: "http://127.0.0.1/" }),
  });
  assert.equal(bad.status, 422);
  assert.equal(await usdc(payTo), before, "failed job must not settle");
  console.log("422 not charged OK");

  // 3. Paid request -> 200, settled, artifacts hashed, receipt anchored, verify OK
  const paid = await paidFetch(`${base}/v1/evidence`, { method: "POST", headers, body });
  const out = (await paid.json()) as {
    receipt: { payment_txid: string; verify_url: string };
    manifest: { sha256: string };
  };
  assert.equal(paid.status, 200, JSON.stringify(out));
  const settle = decodePaymentResponseHeader(paid.headers.get("PAYMENT-RESPONSE") ?? "");
  assert.ok(settle.success);
  assert.equal(settle.transaction, out.receipt.payment_txid);
  assert.equal((await usdc(payTo)) - before, 350_000n);
  console.log("settled", settle.transaction);

  let verify: { verified: boolean; anchor: unknown } | undefined;
  for (let i = 0; i < 20 && !verify?.verified; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(out.receipt.verify_url.replace("http://localhost:4031", base));
    if (res.ok) verify = (await res.json()) as typeof verify;
  }
  assert.ok(verify?.verified, `verify failed: ${JSON.stringify(verify)}`);
  console.log("verify OK", JSON.stringify(verify));

  // 4. Paid MCP tool call over Streamable HTTP -> same payTo, settled, receipt recorded
  const mcp = wrapMCPClientWithPayment(
    // @x402/mcp resolves its own SDK copy (zod 3 peer); the Client is protocol-compatible.
    new Client({ name: "e2e", version: "1.0.0" }) as unknown as Parameters<typeof wrapMCPClientWithPayment>[0],
    client,
  );
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const beforeMcp = await usdc(payTo);
  const tool = await mcp.callTool("attest", { content: "mcp e2e" });
  assert.ok(!tool.isError, JSON.stringify(tool.content));
  assert.ok(tool.paymentMade && tool.paymentResponse?.success, "mcp payment settled");
  assert.equal((await usdc(payTo)) - beforeMcp, 100_000n);
  const mcpOut = JSON.parse((tool.content[0] as unknown as { text: string }).text) as {
    receipt: { payment_txid: string };
  };
  assert.equal(mcpOut.receipt.payment_txid, tool.paymentResponse?.transaction);
  let mcpVerify: { verified: boolean } | undefined;
  for (let i = 0; i < 20 && !mcpVerify?.verified; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const res = await fetch(`${base}/v1/verify/${mcpOut.receipt.payment_txid}`);
    if (res.ok) mcpVerify = (await res.json()) as typeof mcpVerify;
  }
  assert.ok(mcpVerify?.verified, "mcp receipt verified");
  console.log("MCP paid call OK", tool.paymentResponse?.transaction);
  await mcp.close();
  console.log("E2E PASSED");
} finally {
  server.close();
}
