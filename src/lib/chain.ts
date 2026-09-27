import type { PaymentPayload } from "@x402/core/types";
import algosdk from "algosdk";
import { config, requireEnv } from "../config.ts";

export const NOTE_PREFIX = "anvil/v1:j";

let algodClient: algosdk.Algodv2 | undefined;
const endpoint = (raw: string) => {
  const u = new URL(raw);
  return [
    `${u.protocol}//${u.hostname}${u.pathname.replace(/\/$/, "")}`,
    u.port || (u.protocol === "https:" ? 443 : 80),
  ] as const;
};
const algod = () => (algodClient ??= new algosdk.Algodv2(config.ALGOD_TOKEN, ...endpoint(config.algodUrl)));
const indexer = () => new algosdk.Indexer("", ...endpoint(config.indexerUrl));

let account: algosdk.Account | undefined;
export const receiptAccount = () => (account ??= algosdk.mnemonicToSecretKey(requireEnv("RECEIPT_MNEMONIC")));

/** Transaction id of the payer's USDC transfer inside an exact-AVM payment payload. */
export function paymentTxId(payload: Pick<PaymentPayload, "payload">): string | undefined {
  const { paymentGroup, paymentIndex } = payload.payload as { paymentGroup?: string[]; paymentIndex?: number };
  const encoded = paymentGroup?.[paymentIndex ?? -1];
  if (!encoded) return undefined;
  return algosdk.decodeSignedTransaction(Buffer.from(encoded, "base64")).txn.txID();
}

export interface ReceiptNote {
  /** payment transaction id */
  p: string;
  /** sha256 of the job manifest */
  h: string;
  /** route */
  r: string;
}

/** Writes a 0-ALGO self-payment whose ARC-2 note binds the payment to the manifest hash. */
export async function anchorReceipt(note: ReceiptNote): Promise<string> {
  const acct = receiptAccount();
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: acct.addr,
    receiver: acct.addr,
    amount: 0,
    note: new TextEncoder().encode(NOTE_PREFIX + JSON.stringify(note)),
    suggestedParams: await algod().getTransactionParams().do(),
  });
  const { txid } = await algod().sendRawTransaction(txn.signTxn(acct.sk)).do();
  await algosdk.waitForConfirmation(algod(), txid, 8);
  return txid;
}

export async function lookupTransaction(txId: string) {
  return (await indexer().lookupTransactionByID(txId).do()).transaction;
}
