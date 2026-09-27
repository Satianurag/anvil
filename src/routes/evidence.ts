import { z } from "zod";
import { htmlToMarkdown, withPage } from "../lib/browser.ts";
import { defineJob } from "../lib/job.ts";
import { assertPublicUrl } from "../lib/ssrf.ts";
import { sha256 } from "../lib/storage.ts";

export const evidence = defineJob({
  path: "/v1/evidence",
  price: "$0.35",
  description:
    "Notarized web evidence capture: loads a public URL in a real browser and returns a full-page screenshot, PDF, MHTML archive, DOM snapshot and clean markdown, all SHA-256 hashed and bound on Algorand to the payment.",
  input: z.object({
    url: z.url({ protocol: /^https?$/ }).describe("Public http(s) URL to capture"),
    wait_until: z.enum(["load", "domcontentloaded", "networkidle"]).default("load"),
    full_page: z.boolean().default(true),
    viewport: z
      .object({ width: z.int().min(320).max(3840), height: z.int().min(240).max(2160) })
      .default({ width: 1440, height: 900 }),
  }),
  inputExample: { url: "https://example.com" },
  outputExample: {
    final_url: "https://example.com/",
    http_status: 200,
    title: "Example Domain",
    captured_at: "2026-09-27T12:00:00.000Z",
    server_ip: "93.184.215.14",
    tls: { protocol: "TLS 1.3", issuer: "DigiCert Global G3 TLS ECC SHA384 2020 CA1", valid_to: 1767225599 },
    content_sha256: { "screenshot.png": "…", "page.pdf": "…", "page.mhtml": "…", "dom.html": "…", "content.md": "…" },
  },
  timeoutMs: 90_000,
  async run(input, signal) {
    await assertPublicUrl(input.url);
    return withPage({ viewport: input.viewport, signal }, async (page, context) => {
      const response = await page.goto(input.url, { waitUntil: input.wait_until, timeout: 45_000 });
      const capturedAt = new Date().toISOString();
      const [screenshot, pdf, html, security, server] = await Promise.all([
        page.screenshot({ fullPage: input.full_page, type: "png" }),
        page.pdf({ printBackground: true, format: "A4" }),
        page.content(),
        response?.securityDetails(),
        response?.serverAddr(),
      ]);
      const cdp = await context.newCDPSession(page);
      const { data: mhtml } = (await cdp.send("Page.captureSnapshot", { format: "mhtml" })) as { data: string };
      const { markdown } = await htmlToMarkdown(html, page.url());
      const artifacts = [
        { name: "screenshot.png", contentType: "image/png", body: new Uint8Array(screenshot) },
        { name: "page.pdf", contentType: "application/pdf", body: new Uint8Array(pdf) },
        { name: "page.mhtml", contentType: "multipart/related", body: mhtml },
        { name: "dom.html", contentType: "text/html; charset=utf-8", body: html },
        { name: "content.md", contentType: "text/markdown; charset=utf-8", body: markdown },
      ];
      return {
        result: {
          requested_url: input.url,
          final_url: page.url(),
          http_status: response?.status() ?? null,
          response_headers: response ? await response.allHeaders() : {},
          title: await page.title(),
          captured_at: capturedAt,
          server_ip: server?.ipAddress ?? null,
          tls: security
            ? {
                protocol: security.protocol,
                issuer: security.issuer,
                subject: security.subjectName,
                valid_from: security.validFrom,
                valid_to: security.validTo,
              }
            : null,
          content_sha256: Object.fromEntries(artifacts.map((a) => [a.name, sha256(a.body)])),
        },
        artifacts,
      };
    });
  },
});
