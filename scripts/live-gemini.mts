/**
 * Live run of every Gemini-backed route (sandbox routes: see live-sandbox.mts) with real documents rendered locally.
 * Requires GEMINI_API_KEY and `docker compose --profile dev up -d`.
 */
import assert from "node:assert/strict";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON assertions in a live script
type Json = any;
const live = await import("./live-client.mts");
const post = async (path: string, body: unknown) => (await live.post(path, body)).result as Json;

const { htmlToPdf, BASE_CSS } = await import("../src/lib/pdf.ts");

const pdfFile = async (filename: string, body: string) => ({
  file: {
    filename,
    base64: Buffer.from(
      await htmlToPdf(
        `<html><head><style>${BASE_CSS}</style></head><body>${body}</body></html>`,
        AbortSignal.timeout(60_000),
      ),
    ).toString("base64"),
  },
});

const invoice = await pdfFile(
  "invoice.pdf",
  `<h1>INVOICE</h1><p>Invoice # INV-2026-0917<br>Issue date: 2026-09-17<br>Due date: 2026-10-17</p>
<p><b>From:</b> Northwind Analytics Ltd, 12 Harbour St, Leeds LS1 4AB, VAT GB123456789, billing@northwind.example</p>
<p><b>Bill to:</b> Contoso Robotics GmbH, Hauptstr. 5, 10115 Berlin</p>
<table><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr>
<tr><td>Data pipeline audit</td><td>10</td><td>120.00</td><td>1,200.00</td></tr>
<tr><td>Dashboard licence (annual)</td><td>2</td><td>450.00</td><td>900.00</td></tr>
<tr><td>Onboarding workshop</td><td>1</td><td>350.00</td><td>350.00</td></tr></table>
<p>Subtotal: GBP 2,450.00<br>VAT 20%: GBP 490.00<br><b>Total due: GBP 2,940.00</b></p>
<p>Payment terms: Net 30. Bank: Barclays, Sort 20-00-00, Acc 12345678</p>`,
);

const generic = await post("/v1/extract", {
  ...invoice,
  schema: {
    type: "object",
    properties: { invoice_number: { type: "string" }, total: { type: "number" }, currency: { type: "string" } },
    required: ["invoice_number", "total"],
  },
});
assert.equal(generic.valid, true);
assert.equal(generic.data.invoice_number, "INV-2026-0917");
assert.equal(generic.data.total, 2940);
assert.ok(
  generic.evidence.some((e: Json) => e.verified),
  JSON.stringify(generic.evidence),
);

const inv = await post("/v1/extract/invoice", invoice);
assert.equal(inv.data.line_items.length, 3);
assert.equal(inv.checks.line_items_match_subtotal, true, JSON.stringify(inv.checks));
assert.equal(inv.checks.subtotal_plus_tax_matches_total, true, JSON.stringify(inv.checks));

const bank = await post(
  "/v1/extract/bank-statement",
  await pdfFile(
    "statement.pdf",
    `<h1>Monzo Business — Account Statement</h1><p>Account: Jane Doe Consulting, 04-00-04 12345678<br>Period: 01 Sep 2026 – 30 Sep 2026<br>Currency: GBP</p>
<p>Opening balance: 1,000.00</p>
<table><tr><th>Date</th><th>Description</th><th>Money out</th><th>Money in</th><th>Balance</th></tr>
<tr><td>2026-09-01</td><td>Rent — Landlord Ltd</td><td>1,200.00</td><td></td><td>-200.00</td></tr>
<tr><td>2026-09-05</td><td>Client payment — Acme Corp</td><td></td><td>3,500.00</td><td>3,300.00</td></tr>
<tr><td>2026-09-12</td><td>Tesco Groceries</td><td>85.40</td><td></td><td>3,214.60</td></tr>
<tr><td>2026-09-20</td><td>AWS EMEA</td><td>129.99</td><td></td><td>3,084.61</td></tr></table>
<p>Closing balance: 3,084.61</p>`,
  ),
);
assert.equal(bank.data.transactions.length, 4);
assert.equal(bank.reconciliation.reconciled, true, JSON.stringify(bank.reconciliation));

const match = await post("/v1/extract/resume-match", {
  ...(await pdfFile(
    "resume.pdf",
    `<h1>Priya Raman</h1><p>Backend engineer · Bengaluru</p><h2>Experience</h2>
<p><b>Senior Software Engineer, Razorpay</b> (2020–2026): Built payment reconciliation services in TypeScript and Node.js handling 40M transactions/day on PostgreSQL. Led migration to event-driven architecture with Kafka.</p>
<p><b>Software Engineer, Freshworks</b> (2017–2020): Python/Django APIs, Redis caching.</p><h2>Skills</h2><p>TypeScript, Node.js, PostgreSQL, Kafka, Redis, AWS, Docker</p>`,
  )),
  job_description:
    "Senior backend engineer: 5+ years TypeScript/Node.js, PostgreSQL, distributed systems experience required; Kubernetes a plus.",
});
assert.ok(match.overall_score >= 50 && match.overall_score <= 100, String(match.overall_score));
assert.ok(
  match.requirements.some((r: Json) => r.quote_verified === true),
  JSON.stringify(match.requirements),
);

const terms = (days: number, cap: string, law: string) =>
  pdfFile(
    `terms-${days}.pdf`,
    `<h1>Master Services Agreement</h1><h2>1. Fees</h2><p>Customer shall pay all invoices within 30 days of receipt.</p>
<h2>2. Termination</h2><p>Either party may terminate this Agreement with ${days} days written notice.</p>
<h2>3. Liability</h2><p>Each party's total liability is capped at ${cap}.</p><h2>4. Governing law</h2><p>This Agreement is governed by the laws of ${law}.</p>`,
  );
const cmp = await post("/v1/compare", {
  before: await terms(30, "the fees paid in the preceding 12 months", "England and Wales"),
  after: await terms(7, "USD 1,000", "England and Wales"),
  focus: "termination and liability",
});
assert.ok(cmp.changes.length >= 2, JSON.stringify(cmp.changes));
assert.ok(
  cmp.changes.some((c: Json) => c.before_verified && c.after_verified),
  JSON.stringify(cmp.changes),
);

const brief = await post("/v1/research/brief", {
  topic: "Adoption of the x402 HTTP payment protocol on Algorand in 2026",
  snapshot_sources: true,
});
assert.ok(brief.sources.length > 0);
assert.match(brief.brief_markdown, /\[\d+\]/);
console.log(
  `  research: ${brief.model}, ${brief.sources.length} sources, ${brief.sources.filter((s: Json) => s.sha256).length} snapshotted`,
);

console.log("LIVE GEMINI PASSED");
process.exit(0);
