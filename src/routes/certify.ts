import { z } from "zod";
import { signWithReceiptKey } from "../lib/chain.ts";
import { defineJob } from "../lib/job.ts";
import { BASE_CSS, html, htmlToPdf, raw } from "../lib/pdf.ts";
import { sha256 } from "../lib/storage.ts";

export const certify = defineJob({
  path: "/v1/certify",
  price: "$0.25",
  description:
    "Issues a verifiable certificate PDF (completion, membership, authenticity, award): rendered, SHA-256 hashed, Ed25519-signed by Anvil's Algorand receipt key and anchored on-chain; anyone can verify the PDF hash via GET /v1/verify/hash/{sha256}.",
  input: z.object({
    title: z.string().min(1).max(120).describe('e.g. "Certificate of Completion"'),
    recipient: z.string().min(1).max(120),
    issuer: z.string().min(1).max(120),
    statement: z.string().max(1000).optional().describe("Body text, e.g. what was completed"),
    issued_on: z.iso.date().optional(),
    credential_id: z.string().max(80).optional(),
    fields: z.record(z.string().max(60), z.string().max(300)).optional().describe("Extra key/value rows"),
  }),
  inputExample: { title: "Certificate of Completion", recipient: "Ada Lovelace", issuer: "Example Academy" },
  outputExample: {
    pdf_sha256: "…",
    signer: "ANVIL…ALGORANDADDRESS",
    signature: "base64 Ed25519 signature over the PDF sha256 (algosdk signBytes)",
    lookup_path: "/v1/verify/hash/…",
  },
  timeoutMs: 60_000,
  async run(input, signal) {
    const issuedOn = input.issued_on ?? new Date().toISOString().slice(0, 10);
    const credentialId = input.credential_id ?? crypto.randomUUID();
    const rows = Object.entries(input.fields ?? {}).map(([k, v]) => raw(html`<tr><th>${k}</th><td>${v}</td></tr>`));
    const doc = html`<!doctype html><html><head><meta charset="utf-8"><style>${raw(BASE_CSS)}
@page{size:A4 landscape;margin:0}body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center}
.c{border:6px double #1a3d6d;padding:48px 64px;width:80%;text-align:center}.t{font-size:34px;color:#1a3d6d;margin-bottom:24px}
.r{font-size:28px;font-weight:600;margin:12px 0 18px}table{width:60%;margin:18px auto 0}</style></head>
<body><div class="c"><div class="t">${input.title}</div><div class="muted">presented to</div><div class="r">${input.recipient}</div>
<p>${input.statement ?? ""}</p>${rows.length ? raw(html`<table>${rows}</table>`) : ""}
<p style="margin-top:28px">Issued by <b>${input.issuer}</b> on ${issuedOn}</p>
<p class="muted">Credential ID <code>${credentialId}</code> · verifiable on Algorand via Anvil</p></div></body></html>`;
    const pdf = await htmlToPdf(doc, signal);
    const pdfSha = sha256(pdf);
    const sig = signWithReceiptKey(Buffer.from(pdfSha, "hex"));
    const result = {
      credential_id: credentialId,
      title: input.title,
      recipient: input.recipient,
      issuer: input.issuer,
      issued_on: issuedOn,
      pdf_sha256: pdfSha,
      ...sig,
      signature_scheme: 'ed25519 over sha256(pdf) bytes, algosdk signBytes ("MX" prefix)',
      lookup_path: `/v1/verify/hash/${pdfSha}`,
    };
    return {
      result,
      index: [pdfSha],
      artifacts: [
        { name: "certificate.pdf", contentType: "application/pdf", body: pdf },
        { name: "certificate.json", contentType: "application/json", body: JSON.stringify(result, null, 2) },
      ],
    };
  },
});
