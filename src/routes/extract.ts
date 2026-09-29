import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";
import { config, requireEnv } from "../config.ts";
import { documentMarkdown, documentSource, pageCount, quoteIn } from "../lib/documents.ts";
import { defineJob, JobInputError } from "../lib/job.ts";
import { generateJson } from "../lib/llm.ts";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);

export const evidenceItems = {
  type: "array",
  items: {
    type: "object",
    properties: {
      field: { type: "string", description: "JSON pointer of the extracted field, e.g. /total" },
      quote: { type: "string", description: "Exact verbatim text from the document supporting the value" },
    },
    required: ["field", "quote"],
  },
};

/** Document markdown -> Gemini structured output -> JSON Schema validation -> verbatim-quote verification. */
export async function extractFromMarkdown(
  markdown: string,
  schema: Record<string, unknown>,
  instructions: string | undefined,
  signal: AbortSignal,
) {
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    throw new JobInputError(`invalid JSON Schema: ${(err as Error).message}`);
  }
  const parsed = await generateJson<{ data: unknown; evidence?: { field: string; quote: string }[] }>(
    [
      "Extract data from the document below into the given JSON schema. Use null for fields that are absent; never invent values.",
      "For every non-null leaf field add an evidence item quoting the document verbatim.",
      instructions ? `Additional instructions: ${instructions}` : "",
      "<document>",
      markdown,
      "</document>",
    ].join("\n"),
    { type: "object", properties: { data: schema, evidence: evidenceItems }, required: ["data", "evidence"] },
    signal,
  );
  const valid = validate(parsed.data);
  return {
    data: parsed.data,
    valid,
    validation_errors: valid ? [] : validate.errors,
    evidence: (parsed.evidence ?? []).map((e) => ({ ...e, verified: quoteIn(markdown, e.quote) })),
    pages_processed: pageCount(markdown),
    model: config.GEMINI_MODEL,
  };
}

export const extractArtifacts = (markdown: string, result: unknown) => [
  { name: "document.md", contentType: "text/markdown; charset=utf-8", body: markdown },
  { name: "extraction.json", contentType: "application/json", body: JSON.stringify(result, null, 2) },
];

export const extract = defineJob({
  path: "/v1/extract",
  price: "$0.10",
  description:
    "Schema-faithful document extraction: converts a PDF, DOCX, XLSX, PPTX, HTML or image (first 5 pages, OCR included) and returns JSON checked against your JSON Schema (a `valid` flag plus the validation errors), with verbatim source quotes for extracted fields.",
  input: z
    .object({
      ...documentSource.shape,
      schema: z
        .record(z.string(), z.unknown())
        .describe("JSON Schema (draft 2020-12) of the object to extract")
        .superRefine((s, ctx) => {
          try {
            ajv.compile(s);
          } catch (err) {
            ctx.addIssue({ code: "custom", message: `invalid JSON Schema: ${(err as Error).message}` });
          }
        }),
      instructions: z.string().max(2000).optional(),
    })
    .refine((v) => !!v.url !== !!v.file, "provide exactly one of url or file"),
  inputExample: {
    url: "https://example.com/invoice.pdf",
    schema: {
      type: "object",
      properties: { invoice_number: { type: "string" }, total: { type: "number" }, currency: { type: "string" } },
      required: ["invoice_number", "total"],
    },
  },
  outputExample: {
    data: { invoice_number: "INV-1042", total: 1250.5, currency: "USD" },
    valid: true,
    evidence: [{ field: "/invoice_number", quote: "Invoice # INV-1042", verified: true }],
    pages_processed: 2,
  },
  timeoutMs: 480_000,
  async run(input, signal) {
    ajv.compile(input.schema);
    requireEnv("GEMINI_API_KEY");
    const markdown = await documentMarkdown(input, signal);
    const result = await extractFromMarkdown(markdown, input.schema, input.instructions, signal);
    return { result, artifacts: extractArtifacts(markdown, result) };
  },
});
