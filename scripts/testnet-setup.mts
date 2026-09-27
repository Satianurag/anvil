/**
 * Prepares Testnet accounts for a paid live run: the funded payer (LIVE_PAYER_MNEMONIC) tops up the payTo
 * (PAYTO_MNEMONIC) and receipt (RECEIPT_MNEMONIC) accounts with ALGO, and payer + payTo opt in to Testnet USDC.
 */
import { AlgorandClient, algo } from "@algorandfoundation/algokit-utils";
import algosdk from "algosdk";

const USDC = 10458941n;
const algorand = AlgorandClient.testNet();
const acct = (name: string) => {
  const m = process.env[name];
  if (!m) throw new Error(`${name} is not set`);
  const a = algosdk.mnemonicToSecretKey(m);
  algorand.setSignerFromAccount(a);
  return a.addr.toString();
};
const [payer, payTo, receipts] = [acct("LIVE_PAYER_MNEMONIC"), acct("PAYTO_MNEMONIC"), acct("RECEIPT_MNEMONIC")];

for (const [addr, target] of [
  [payTo, 0.5],
  [receipts, 1],
] as const) {
  const { balance } = await algorand.account.getInformation(addr);
  if (balance.algo < target) await algorand.send.payment({ sender: payer, receiver: addr, amount: algo(target) });
}
for (const addr of [payer, payTo]) {
  const info = await algorand.account.getInformation(addr);
  if (!info.assets?.some((a) => a.assetId === USDC)) await algorand.send.assetOptIn({ sender: addr, assetId: USDC });
}
for (const [n, addr] of Object.entries({ payer, payTo, receipts })) {
  const info = await algorand.account.getInformation(addr);
  const usdc = info.assets?.find((a) => a.assetId === USDC)?.amount ?? 0n;
  console.log(n, addr, `${info.balance.algo} ALGO`, `${Number(usdc) / 1e6} USDC`);
}
