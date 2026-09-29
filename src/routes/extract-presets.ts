import { z } from "zod";
import { requireEnv } from "../config.ts";
import { documentMarkdown, documentSource, pageCount, quoteIn } from "../lib/documents.ts";
import { defineJob } from "../lib/job.ts";
import { generateJson } from "../lib/llm.ts";
import { extractArtifacts, extractFromMarkdown } from "./extract.ts";

const str = { type: ["string", "null"] };
const num = { type: ["number", "null"] };
const docExample = { url: "https://example.com/document.pdf" };

const INVOICE_SCHEMA = {
  type: "object",
  properties: {
    invoice_number: str,
    issue_date: { ...str, description: "ISO 8601 date" },
    due_date: { ...str, description: "ISO 8601 date" },
    currency: { ...str, description: "ISO 4217 code" },
    vendor: { type: "object", properties: { name: str, address: str, tax_id: str, email: str } },
    customer: { type: "object", properties: { name: str, address: str, tax_id: str } },
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: { description: str, quantity: num, unit_price: num, amount: num },
      },
    },
    subtotal: num,
    tax: num,
    total: num,
    payment_terms: str,
    bank_details: str,
  },
  required: ["invoice_number", "total", "line_items"],
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export const extractInvoice = defineJob({
  path: "/v1/extract/invoice",
  price: "$0.10",
  description:
    "Invoice / receipt to accounting-ready JSON (vendor, customer, dates, line items, tax, totals, bank details) with verbatim evidence per field and arithmetic checks (line items vs subtotal, subtotal + tax vs total).",
  input: documentSource,
  inputExample: docExample,
  outputExample: {
    data: { invoice_number: "INV-1042", total: 1250.5, currency: "USD", line_items: [] },
    checks: { line_items_match_subtotal: true, subtotal_plus_tax_matches_total: true },
  },
  timeoutMs: 480_000,
  async run(input, signal) {
    requireEnv("GEMINI_API_KEY");
    const markdown = await documentMarkdown(input, signal);
    const out = await extractFromMarkdown(markdown, INVOICE_SCHEMA, undefined, signal);
    const d = out.data as {
      line_items?: { amount: number | null }[];
      subtotal?: number | null;
      tax?: number | null;
      total?: number | null;
    };
    const itemsSum = round2((d.line_items ?? []).reduce((s, i) => s + (i.amount ?? 0), 0));
    const result = {
      ...out,
      checks: {
        line_items_sum: itemsSum,
        line_items_match_subtotal: d.subtotal == null ? null : Math.abs(itemsSum - d.subtotal) < 0.015,
        subtotal_plus_tax_matches_total:
          d.subtotal == null || d.total == null ? null : Math.abs(d.subtotal + (d.tax ?? 0) - d.total) < 0.015,
      },
    };
    return { result, artifacts: extractArtifacts(markdown, result) };
  },
});

const BANK_SCHEMA = {
  type: "object",
  properties: {
    bank_name: str,
    account_holder: str,
    account_number_last4: str,
    currency: str,
    period_start: { ...str, description: "ISO 8601 date" },
    period_end: { ...str, description: "ISO 8601 date" },
    opening_balance: num,
    closing_balance: num,
    transactions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          date: { ...str, description: "ISO 8601 date" },
          description: str,
          amount: { type: "number", description: "Signed: credits positive, debits negative" },
          balance: num,
          category: {
            type: "string",
            enum: ["income", "transfer", "rent", "utilities", "groceries", "dining", "travel", "fees", "tax", "other"],
          },
        },
        required: ["date", "description", "amount"],
      },
    },
  },
  required: ["opening_balance", "closing_balance", "transactions"],
};

export const extractBankStatement = defineJob({
  path: "/v1/extract/bank-statement",
  price: "$0.35",
  description:
    "Bank statement to categorised transaction ledger (signed amounts, running balances, categories) with a reconciliation check: opening balance + sum(transactions) must equal closing balance. Returns JSON and CSV.",
  input: documentSource,
  inputExample: docExample,
  outputExample: {
    data: { opening_balance: 1000, closing_balance: 1234.56, transactions: [] },
    reconciliation: { computed_closing: 1234.56, reconciled: true, difference: 0 },
    totals_by_category: { income: 2500, rent: -1200 },
  },
  timeoutMs: 480_000,
  async run(input, signal) {
    requireEnv("GEMINI_API_KEY");
    const markdown = await documentMarkdown(input, signal);
    const out = await extractFromMarkdown(
      markdown,
      BANK_SCHEMA,
      "Include every transaction row in statement order. Credits are positive, debits negative.",
      signal,
    );
    const d = out.data as {
      opening_balance: number | null;
      closing_balance: number | null;
      transactions: { date: string; description: string; amount: number; balance?: number | null; category?: string }[];
    };
    const sum = round2(d.transactions.reduce((s, t) => s + t.amount, 0));
    const computed = d.opening_balance == null ? null : round2(d.opening_balance + sum);
    const byCategory: Record<string, number> = {};
    for (const t of d.transactions)
      byCategory[t.category ?? "other"] = round2((byCategory[t.category ?? "other"] ?? 0) + t.amount);
    const result = {
      ...out,
      reconciliation: {
        transactions: d.transactions.length,
        net_change: sum,
        computed_closing: computed,
        reconciled:
          computed == null || d.closing_balance == null ? null : Math.abs(computed - d.closing_balance) < 0.015,
        difference: computed == null || d.closing_balance == null ? null : round2(d.closing_balance - computed),
      },
      totals_by_category: byCategory,
    };
    const csvCell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [
      "date,description,amount,balance,category",
      ...d.transactions.map((t) => [t.date, t.description, t.amount, t.balance, t.category].map(csvCell).join(",")),
    ].join("\n");
    return {
      result,
      artifacts: [
        ...extractArtifacts(markdown, result),
        { name: "transactions.csv", contentType: "text/csv; charset=utf-8", body: csv },
      ],
    };
  },
});

const MATCH_SCHEMA = {
  type: "object",
  properties: {
    candidate_name: str,
    overall_score: { type: "integer", minimum: 0, maximum: 100 },
    summary: { type: "string" },
    requirements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          requirement: { type: "string", description: "Requirement from the job description" },
          must_have: { type: "boolean" },
          status: { type: "string", enum: ["met", "partial", "not_met"] },
          resume_quote: { type: ["string", "null"], description: "Verbatim resume text supporting the status" },
          note: { type: "string" },
        },
        required: ["requirement", "must_have", "status", "resume_quote"],
      },
    },
    strengths: { type: "array", items: { type: "string" } },
    gaps: { type: "array", items: { type: "string" } },
    interview_questions: { type: "array", items: { type: "string" } },
  },
  required: ["overall_score", "summary", "requirements", "gaps", "interview_questions"],
};

export const extractResumeMatch = defineJob({
  path: "/v1/extract/resume-match",
  price: "$0.25",
  description:
    "Resume vs job description screening: scores the candidate requirement-by-requirement (met / partial / not met) with verbatim resume quotes checked against the source, plus strengths, gaps and interview questions. Assistive screening aid, not an automated hiring decision.",
  input: z
    .object({
      ...documentSource.shape,
      job_description: z.string().min(50).max(20_000),
    })
    .refine((v) => !!v.url !== !!v.file, "provide exactly one of url or file (the resume)"),
  inputExample: {
    url: "https://example.com/resume.pdf",
    job_description:
      "Senior backend engineer: 5+ years TypeScript/Node.js, PostgreSQL, distributed systems; Kubernetes a plus.",
  },
  outputExample: {
    overall_score: 72,
    requirements: [
      { requirement: "5+ years TypeScript", must_have: true, status: "met", resume_quote: "…", quote_verified: true },
    ],
    gaps: ["No Kubernetes experience evidenced"],
  },
  timeoutMs: 480_000,
  async run(input, signal) {
    requireEnv("GEMINI_API_KEY");
    const markdown = await documentMarkdown(input, signal);
    const out = await generateJson<{ requirements: { resume_quote: string | null }[] } & Record<string, unknown>>(
      [
        "You are an impartial technical recruiter. Compare the resume to the job description.",
        "List each distinct requirement from the job description. For each, quote the resume verbatim as evidence or use null.",
        "Judge only job-relevant qualifications; ignore age, gender, ethnicity, religion, disability and other protected attributes.",
        "<job_description>",
        input.job_description,
        "</job_description>",
        "<resume>",
        markdown,
        "</resume>",
      ].join("\n"),
      MATCH_SCHEMA,
      signal,
    );
    const result = {
      ...out,
      requirements: out.requirements.map((r) => ({
        ...r,
        quote_verified: r.resume_quote ? quoteIn(markdown, r.resume_quote) : null,
      })),
      pages_processed: pageCount(markdown),
    };
    return { result, artifacts: extractArtifacts(markdown, result) };
  },
});

export const compare = defineJob({
  path: "/v1/compare",
  price: "$0.25",
  description:
    "Semantic document comparison (contracts, policies, terms, specs): converts two versions and returns a list of material changes (added / removed / modified) with verbatim before/after quotes verified against each version and a risk-oriented significance rating.",
  input: z.object({
    before: documentSource,
    after: documentSource,
    focus: z.string().max(1000).optional().describe('e.g. "payment terms, liability, termination"'),
  }),
  inputExample: {
    before: { url: "https://example.com/terms-v1.pdf" },
    after: { url: "https://example.com/terms-v2.pdf" },
  },
  outputExample: {
    changes: [
      {
        type: "modified",
        section: "Termination",
        before_quote: "30 days notice",
        after_quote: "7 days notice",
        significance: "high",
        before_verified: true,
        after_verified: true,
      },
    ],
  },
  timeoutMs: 480_000,
  async run(input, signal) {
    requireEnv("GEMINI_API_KEY");
    const [a, b] = await Promise.all([documentMarkdown(input.before, signal), documentMarkdown(input.after, signal)]);
    const out = await generateJson<{
      summary: string;
      changes: { before_quote: string | null; after_quote: string | null }[];
    }>(
      [
        "Compare the BEFORE and AFTER versions of a document. List every material change in meaning; ignore pure formatting.",
        "Quote the affected text verbatim from each version (null for pure additions/removals).",
        input.focus ? `Pay particular attention to: ${input.focus}` : "",
        "<before>",
        a,
        "</before>",
        "<after>",
        b,
        "</after>",
      ].join("\n"),
      {
        type: "object",
        properties: {
          summary: { type: "string" },
          changes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string", enum: ["added", "removed", "modified"] },
                section: { type: "string" },
                before_quote: { type: ["string", "null"] },
                after_quote: { type: ["string", "null"] },
                explanation: { type: "string" },
                significance: { type: "string", enum: ["low", "medium", "high"] },
              },
              required: ["type", "section", "before_quote", "after_quote", "explanation", "significance"],
            },
          },
        },
        required: ["summary", "changes"],
      },
      signal,
    );
    const result = {
      ...out,
      changes: out.changes.map((c) => ({
        ...c,
        before_verified: c.before_quote ? quoteIn(a, c.before_quote) : null,
        after_verified: c.after_quote ? quoteIn(b, c.after_quote) : null,
      })),
    };
    return {
      result,
      artifacts: [
        { name: "before.md", contentType: "text/markdown; charset=utf-8", body: a },
        { name: "after.md", contentType: "text/markdown; charset=utf-8", body: b },
        { name: "changes.json", contentType: "application/json", body: JSON.stringify(result, null, 2) },
      ],
    };
  },
});
