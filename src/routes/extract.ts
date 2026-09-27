import { GoogleGenAI } from "@google/genai";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";
import { config, requireEnv } from "../config.ts";
import { defineJob, JobInputError } from "../lib/job.ts";
import { safeFetch } from "../lib/safe-fetch.ts";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 5;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s*_`|#>]+/g, " ")
    .trim();

export async function toMarkdown(source: { base64: string; filename: string }, signal: AbortSignal) {
  const res = await fetch(new URL("/v1/convert/source", config.DOCLING_URL), {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sources: [{ kind: "file", base64_string: source.base64, filename: source.filename }],
      options: {
        to_formats: ["md"],
        page_range: [1, MAX_PAGES],
        image_export_mode: "placeholder",
        abort_on_error: true,
      },
    }),
  });
  if (!res.ok) throw new Error(`docling-serve HTTP ${res.status}: ${await res.text()}`);
  const out = (await res.json()) as { status: string; document: { md_content: string | null }; errors: unknown[] };
  if (out.status !== "success" || !out.document.md_content)
    throw new JobInputError(`document conversion ${out.status}: ${JSON.stringify(out.errors)}`);
  return out.document.md_content;
}

export const extract = defineJob({
  path: "/v1/extract",
  price: "$0.10",
  description:
    "Schema-faithful document extraction: converts a PDF, DOCX, XLSX, PPTX, HTML or image (first 5 pages, OCR included) and returns JSON that validates against your JSON Schema, with a verbatim source quote for every extracted field.",
  input: z
    .object({
      url: z
        .url({ protocol: /^https?$/ })
        .optional()
        .describe("Public URL of the document"),
      file: z
        .object({ base64: z.base64(), filename: z.string().min(1).max(200) })
        .optional()
        .describe("Inline document"),
      schema: z.record(z.string(), z.unknown()).describe("JSON Schema (draft 2020-12) of the object to extract"),
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
    evidence: [{ field: "invoice_number", quote: "Invoice # INV-1042", verified: true }],
    pages_processed: 2,
  },
  timeoutMs: 180_000,
  async run(input, signal) {
    let validate: ReturnType<typeof ajv.compile>;
    try {
      validate = ajv.compile(input.schema);
    } catch (err) {
      throw new JobInputError(`invalid JSON Schema: ${(err as Error).message}`);
    }
    const apiKey = requireEnv("GEMINI_API_KEY");

    const source = input.file
      ? input.file
      : await safeFetch(input.url as string, MAX_BYTES, signal).then(({ url, body }) => ({
          base64: Buffer.from(body).toString("base64"),
          filename: decodeURIComponent(url.pathname.split("/").pop() || "document") || "document",
        }));
    if (Buffer.byteLength(source.base64, "base64") > MAX_BYTES)
      throw new JobInputError(`document exceeds ${MAX_BYTES} bytes`);
    const markdown = await toMarkdown(source, signal);

    const responseSchema = {
      type: "object",
      properties: {
        data: input.schema,
        evidence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string", description: "JSON pointer of the extracted field, e.g. /total" },
              quote: { type: "string", description: "Exact verbatim text from the document supporting the value" },
            },
            required: ["field", "quote"],
          },
        },
      },
      required: ["data", "evidence"],
    };
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: config.GEMINI_MODEL,
      contents: [
        "Extract data from the document below into the given JSON schema. Use null for fields that are absent; never invent values.",
        "For every non-null leaf field add an evidence item quoting the document verbatim.",
        input.instructions ? `Additional instructions: ${input.instructions}` : "",
        "<document>",
        markdown,
        "</document>",
      ].join("\n"),
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: responseSchema,
        temperature: 0,
        abortSignal: signal,
      },
    });
    const parsed = JSON.parse(response.text ?? "{}") as { data: unknown; evidence: { field: string; quote: string }[] };
    const haystack = normalize(markdown);
    const valid = validate(parsed.data);
    const result = {
      data: parsed.data,
      valid,
      validation_errors: valid ? [] : validate.errors,
      evidence: (parsed.evidence ?? []).map((e) => ({ ...e, verified: haystack.includes(normalize(e.quote)) })),
      pages_processed: Math.min(MAX_PAGES, (markdown.match(/<!-- page break -->/g)?.length ?? 0) + 1),
      model: config.GEMINI_MODEL,
    };
    return {
      result,
      artifacts: [
        { name: "document.md", contentType: "text/markdown; charset=utf-8", body: markdown },
        { name: "extraction.json", contentType: "application/json", body: JSON.stringify(result, null, 2) },
      ],
    };
  },
});
