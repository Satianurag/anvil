import { z } from "zod";
import { config, requireEnv } from "../config.ts";
import { htmlToMarkdown } from "../lib/browser.ts";
import { defineJob } from "../lib/job.ts";
import { generateGrounded } from "../lib/llm.ts";
import { markdownToPdf } from "../lib/pdf.ts";
import { safeFetch } from "../lib/safe-fetch.ts";
import { sha256 } from "../lib/storage.ts";

const MAX_SOURCES = 10;

/** Grounding chunk URIs are Google redirect links; follow them (safely) to the publisher page and snapshot it. */
async function snapshot(uri: string, signal: AbortSignal) {
  try {
    const { url, body, contentType } = await safeFetch(
      uri,
      5_000_000,
      AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    );
    const text = new TextDecoder().decode(body);
    const markdown = contentType.includes("html") ? (await htmlToMarkdown(text, url.href)).markdown : text;
    return { url: url.href, markdown, captured_at: new Date().toISOString() };
  } catch (err) {
    return { url: uri, markdown: null, error: (err as Error).message };
  }
}

export const research = defineJob({
  path: "/v1/research/brief",
  price: "$0.75",
  description:
    "Cited research brief / due-diligence dossier: Gemini with live Google Search grounding writes a structured brief where every claim carries numbered citations; each cited source page is snapshotted and SHA-256 hashed so the evidence survives link rot. Returns Markdown, PDF and source snapshots.",
  input: z.object({
    topic: z.string().min(3).max(500).describe('e.g. "Due diligence on Acme Robotics Inc." or a research question'),
    focus: z.string().max(1000).optional().describe("Angles to cover, audience, exclusions"),
    snapshot_sources: z.boolean().default(true),
  }),
  inputExample: { topic: "State of x402 agent payments adoption in 2026" },
  outputExample: {
    title: "State of x402 agent payments adoption in 2026",
    brief_markdown: "## Summary\nx402 volume grew … [1][3]",
    sources: [{ n: 1, title: "example.com", url: "https://example.com/report", sha256: "…" }],
    search_queries: ["x402 adoption 2026"],
  },
  timeoutMs: 240_000,
  async run(input, signal) {
    requireEnv("GEMINI_API_KEY");
    const response = await generateGrounded(
      [
        `Write a rigorous, well-structured research brief on: ${input.topic}`,
        input.focus ? `Focus: ${input.focus}` : "",
        "Use Markdown with sections: Summary, Key findings, Details, Risks / open questions, Conclusion.",
        "Search the web thoroughly; state only facts supported by sources, include dates and figures, and flag uncertainty.",
      ].join("\n"),
      signal,
    );
    const text = response.text ?? "";
    const meta = response.candidates?.[0]?.groundingMetadata;
    const chunks = (meta?.groundingChunks ?? []).map((c) => c.web).filter((w) => w?.uri);
    if (!text || chunks.length === 0) throw new Error("model returned no grounded answer");

    // Insert [n] citation markers at the end of each supported segment (from the end so offsets stay valid).
    const bytes = Buffer.from(text, "utf8");
    const inserts = (meta?.groundingSupports ?? [])
      .filter((s) => s.segment?.endIndex !== undefined && s.groundingChunkIndices?.length)
      .map((s) => ({
        at: s.segment?.endIndex as number,
        refs: (s.groundingChunkIndices ?? []).map((i) => `[${i + 1}]`).join(""),
      }))
      .sort((a, b) => b.at - a.at);
    let cited = bytes;
    for (const { at, refs } of inserts)
      cited = Buffer.concat([cited.subarray(0, at), Buffer.from(refs), cited.subarray(at)]);
    const brief = cited.toString("utf8");

    const used = chunks.slice(0, MAX_SOURCES);
    const snaps = input.snapshot_sources
      ? await Promise.all(used.map((w) => snapshot(w?.uri as string, signal)))
      : used.map((w) => ({ url: w?.uri as string, markdown: null }));
    const sources = used.map((w, i) => ({
      n: i + 1,
      title: w?.title ?? null,
      url: snaps[i].url,
      captured_at: "captured_at" in snaps[i] ? snaps[i].captured_at : null,
      sha256: snaps[i].markdown ? sha256(snaps[i].markdown) : null,
      snapshot: snaps[i].markdown ? `source-${i + 1}.md` : null,
      error: "error" in snaps[i] ? snaps[i].error : undefined,
    }));
    const document = [
      `# ${input.topic}`,
      `_Generated ${new Date().toISOString()} by Anvil (${config.GEMINI_SEARCH_MODEL}, Google Search grounding)_`,
      brief,
      "## Sources",
      ...sources.map(
        (s) => `${s.n}. [${s.title ?? s.url}](${s.url})${s.sha256 ? ` — snapshot sha256 \`${s.sha256}\`` : ""}`,
      ),
    ].join("\n\n");
    const pdf = await markdownToPdf(document, input.topic, signal);
    const result = {
      title: input.topic,
      brief_markdown: brief,
      sources,
      search_queries: meta?.webSearchQueries ?? [],
      model: config.GEMINI_SEARCH_MODEL,
    };
    return {
      result,
      artifacts: [
        { name: "brief.md", contentType: "text/markdown; charset=utf-8", body: document },
        { name: "brief.pdf", contentType: "application/pdf", body: pdf },
        ...snaps.flatMap((s, i) =>
          s.markdown
            ? [{ name: `source-${i + 1}.md`, contentType: "text/markdown; charset=utf-8", body: s.markdown }]
            : [],
        ),
      ],
    };
  },
});
