import { z } from "zod";
import { config } from "../config.ts";
import { JobInputError } from "./job.ts";
import { safeFetch } from "./safe-fetch.ts";

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_PAGES = 5;

export const documentSource = z
  .object({
    url: z
      .url({ protocol: /^https?$/ })
      .optional()
      .describe("Public URL of the document"),
    file: z
      .object({ base64: z.base64(), filename: z.string().min(1).max(200) })
      .optional()
      .describe("Inline document"),
  })
  .refine((v) => !!v.url !== !!v.file, "provide exactly one of url or file");
export type DocumentSource = z.infer<typeof documentSource>;

export async function loadDocument(src: DocumentSource, signal: AbortSignal) {
  const doc = src.file
    ? src.file
    : await safeFetch(src.url as string, MAX_DOCUMENT_BYTES, signal).then(({ url, body }) => ({
        base64: Buffer.from(body).toString("base64"),
        filename: decodeURIComponent(url.pathname.split("/").pop() || "document") || "document",
      }));
  if (Buffer.byteLength(doc.base64, "base64") > MAX_DOCUMENT_BYTES)
    throw new JobInputError(`document exceeds ${MAX_DOCUMENT_BYTES} bytes`);
  return doc;
}

/** Converts a document (PDF, DOCX, XLSX, PPTX, HTML, image; OCR included) to Markdown with docling-serve. */
export async function toMarkdown(doc: { base64: string; filename: string }, signal: AbortSignal) {
  const res = await fetch(new URL("/v1/convert/source", config.DOCLING_URL), {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sources: [{ kind: "file", base64_string: doc.base64, filename: doc.filename }],
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

export const documentMarkdown = async (src: DocumentSource, signal: AbortSignal) =>
  toMarkdown(await loadDocument(src, signal), signal);

export const pageCount = (markdown: string) =>
  Math.min(MAX_PAGES, (markdown.match(/<!-- page break -->/g)?.length ?? 0) + 1);

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s*_`|#>]+/g, " ")
    .trim();

/** True when `quote` appears verbatim (modulo whitespace/markdown punctuation/case) in `source`. */
export const quoteIn = (source: string, quote: string) =>
  !!quote.trim() && normalize(source).includes(normalize(quote));
