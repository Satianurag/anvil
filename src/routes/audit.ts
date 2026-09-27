import { AxeBuilder } from "@axe-core/playwright";
import { z } from "zod";
import { config } from "../config.ts";
import { withPage } from "../lib/browser.ts";
import { defineJob } from "../lib/job.ts";
import { BASE_CSS, html, htmlToPdf, raw } from "../lib/pdf.ts";
import { safeFetch } from "../lib/safe-fetch.ts";
import { assertPublicUrl } from "../lib/ssrf.ts";

const CATEGORIES = ["performance", "accessibility", "best-practices", "seo"] as const;

interface LighthouseResult {
  lighthouseResult: {
    categories: Record<string, { score: number | null }>;
    audits: Record<string, { title: string; score: number | null; displayValue?: string; scoreDisplayMode: string }>;
  };
}

/** Lighthouse via Google PageSpeed Insights (runs on Google's infrastructure, so no crawler SSRF surface here). */
async function lighthouse(url: string, strategy: "mobile" | "desktop", signal: AbortSignal) {
  const api = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  api.searchParams.set("url", url);
  api.searchParams.set("strategy", strategy);
  for (const c of CATEGORIES) api.searchParams.append("category", c);
  if (config.PAGESPEED_API_KEY) api.searchParams.set("key", config.PAGESPEED_API_KEY);
  const res = await fetch(api, { signal });
  if (!res.ok) throw new Error(`PageSpeed Insights HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as LighthouseResult;
  const { categories, audits } = body.lighthouseResult;
  return {
    raw: body,
    scores: Object.fromEntries(
      CATEGORIES.map((c) => [c, categories[c]?.score == null ? null : Math.round((categories[c].score ?? 0) * 100)]),
    ),
    metrics: Object.fromEntries(
      [
        "first-contentful-paint",
        "largest-contentful-paint",
        "total-blocking-time",
        "cumulative-layout-shift",
        "speed-index",
      ]
        .filter((k) => audits[k])
        .map((k) => [k, audits[k].displayValue ?? null]),
    ),
    failed_audits: Object.entries(audits)
      .filter(([, a]) => a.score !== null && a.score < 0.9 && ["binary", "numeric"].includes(a.scoreDisplayMode))
      .map(([id, a]) => ({ id, title: a.title, score: a.score, value: a.displayValue ?? null }))
      .slice(0, 40),
  };
}

async function exists(url: string, signal: AbortSignal) {
  try {
    await safeFetch(url, 5_000_000, signal);
    return true;
  } catch {
    return false;
  }
}

export const audit = defineJob({
  path: "/v1/audit/site",
  price: "$0.50",
  description:
    "Website audit report: Lighthouse performance/accessibility/best-practices/SEO scores, axe-core WCAG 2.2 AA violations with offending selectors, on-page SEO checks (title, meta, headings, alt text, canonical, robots, sitemap) and a full-page screenshot, delivered as a PDF report plus JSON.",
  input: z.object({
    url: z.url({ protocol: /^https?$/ }),
    strategy: z.enum(["mobile", "desktop"]).default("mobile"),
    lighthouse: z.boolean().default(true).describe("Include Lighthouse scores (via PageSpeed Insights)"),
  }),
  inputExample: { url: "https://example.com" },
  outputExample: {
    scores: { performance: 98, accessibility: 91, "best-practices": 100, seo: 90 },
    accessibility: { violations: 3, by_impact: { serious: 2, moderate: 1 } },
    seo: { title: "Example Domain", issues: ["missing meta description"] },
  },
  timeoutMs: 150_000,
  async run(input, signal) {
    const target = await assertPublicUrl(input.url);
    const lh = input.lighthouse ? lighthouse(input.url, input.strategy, signal) : undefined;
    lh?.catch(() => {});
    const viewport = input.strategy === "mobile" ? { width: 412, height: 915 } : { width: 1440, height: 900 };
    const page = await withPage({ viewport, signal }, async (page) => {
      const response = await page.goto(input.url, { waitUntil: "load", timeout: 45_000 });
      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      const onPage = await page.evaluate(() => {
        const m: Record<string, string | null> = Object.fromEntries(
          ["description", "robots", "viewport", "og:title", "og:image"].map((n) => [
            n,
            document.querySelector<HTMLMetaElement>(`meta[name="${n}"],meta[property="${n}"]`)?.content ?? null,
          ]),
        );
        return {
          title: document.title || null,
          meta_description: m.description,
          canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? null,
          lang: document.documentElement.lang || null,
          robots_meta: m.robots,
          viewport_meta: m.viewport,
          og_title: m["og:title"],
          og_image: m["og:image"],
          h1: [...document.querySelectorAll("h1")].map((h) => h.textContent?.trim() ?? ""),
          images: document.images.length,
          images_missing_alt: [...document.images].filter((i) => !i.hasAttribute("alt")).length,
          links: document.links.length,
          word_count: document.body?.innerText.split(/\s+/).filter(Boolean).length ?? 0,
        };
      });
      const screenshot = await page.screenshot({ fullPage: true, type: "png" });
      return { status: response?.status() ?? null, finalUrl: page.url(), axe, onPage, screenshot };
    });

    const origin = new URL(page.finalUrl).origin || target.origin;
    const [robotsTxt, sitemap] = await Promise.all([
      exists(`${origin}/robots.txt`, signal),
      exists(`${origin}/sitemap.xml`, signal),
    ]);
    const s = page.onPage;
    const seoIssues = [
      !s.title && "missing <title>",
      s.title && (s.title.length < 10 || s.title.length > 65) && `title length ${s.title.length} (aim 10–65)`,
      !s.meta_description && "missing meta description",
      s.meta_description &&
        (s.meta_description.length < 50 || s.meta_description.length > 160) &&
        `meta description length ${s.meta_description.length} (aim 50–160)`,
      s.h1.length !== 1 && `${s.h1.length} <h1> elements (expected 1)`,
      !s.canonical && "missing canonical link",
      !s.lang && "missing <html lang>",
      !s.viewport_meta && "missing viewport meta",
      s.images_missing_alt > 0 && `${s.images_missing_alt} images without alt`,
      /noindex/i.test(s.robots_meta ?? "") && "page is noindex",
      !robotsTxt && "no /robots.txt",
      !sitemap && "no /sitemap.xml",
      !s.og_title && "missing og:title",
    ].filter((x): x is string => !!x);

    const violations = page.axe.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? null,
      help: v.help,
      help_url: v.helpUrl,
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
    }));
    const byImpact: Record<string, number> = {};
    for (const v of violations) byImpact[v.impact ?? "unknown"] = (byImpact[v.impact ?? "unknown"] ?? 0) + 1;
    let lighthouseError: string | null = null;
    const lhOut = lh
      ? await lh.catch((err: Error) => {
          lighthouseError = err.message;
          return undefined;
        })
      : undefined;

    const result = {
      url: input.url,
      final_url: page.finalUrl,
      http_status: page.status,
      strategy: input.strategy,
      audited_at: new Date().toISOString(),
      scores: lhOut?.scores ?? null,
      metrics: lhOut?.metrics ?? null,
      lighthouse_failed_audits: lhOut?.failed_audits ?? [],
      lighthouse_error: lighthouseError,
      accessibility: {
        engine: `axe-core ${page.axe.testEngine.version}`,
        violations: violations.length,
        by_impact: byImpact,
        details: violations,
      },
      seo: { ...s, robots_txt: robotsTxt, sitemap_xml: sitemap, issues: seoIssues },
    };

    const report = html`<!doctype html><html><head><meta charset="utf-8"><style>${raw(BASE_CSS)}</style></head><body>
<h1>Site audit</h1><div class="muted">${result.final_url} · ${input.strategy} · ${result.audited_at} · HTTP ${result.http_status}</div>
${
  lhOut
    ? raw(html`<h2>Lighthouse</h2><table><tr>${CATEGORIES.map((c) => raw(html`<th>${c}</th>`))}</tr><tr>${CATEGORIES.map((c) => raw(html`<td><b>${lhOut.scores[c] ?? "–"}</b></td>`))}</tr></table>
<p>${Object.entries(lhOut.metrics).map(([k, v]) => raw(html`${k}: <b>${v}</b> &nbsp; `))}</p>
<table><tr><th>Failed audit</th><th>Score</th><th>Value</th></tr>${lhOut.failed_audits.map((a) => raw(html`<tr><td>${a.title}</td><td>${a.score}</td><td>${a.value ?? ""}</td></tr>`))}</table>`)
    : lighthouseError
      ? raw(html`<h2>Lighthouse</h2><p class="muted">Unavailable: ${lighthouseError}</p>`)
      : ""
}
<h2>Accessibility (WCAG 2.2 AA, ${result.accessibility.engine}) — ${violations.length} violations</h2>
<table><tr><th>Rule</th><th>Impact</th><th>Nodes</th><th>Examples</th></tr>${violations.map((v) => raw(html`<tr><td><a href="${v.help_url}">${v.id}</a><br>${v.help}</td><td>${v.impact}</td><td>${v.nodes}</td><td><code>${v.targets.join("\n")}</code></td></tr>`))}</table>
<h2>SEO — ${seoIssues.length} issues</h2><ul>${seoIssues.map((i) => raw(html`<li>${i}</li>`))}</ul>
<table>${(["title", "meta_description", "canonical", "lang", "og_title", "og_image"] as const).map((k) => raw(html`<tr><th>${k}</th><td>${s[k] ?? "–"}</td></tr>`))}</table>
<h2>Screenshot</h2><img src="screenshot.png" style="width:100%;border:1px solid #ddd"></body></html>`;
    const screenshot = new Uint8Array(page.screenshot);
    const pdf = await htmlToPdf(report, signal, { "screenshot.png": screenshot });
    return {
      result,
      artifacts: [
        { name: "report.pdf", contentType: "application/pdf", body: pdf },
        { name: "report.json", contentType: "application/json", body: JSON.stringify(result, null, 2) },
        { name: "screenshot.png", contentType: "image/png", body: screenshot },
        { name: "axe.json", contentType: "application/json", body: JSON.stringify(page.axe, null, 2) },
        ...(lhOut
          ? [
              {
                name: "lighthouse.json",
                contentType: "application/json",
                body: JSON.stringify(lhOut.raw.lighthouseResult),
              },
            ]
          : []),
      ],
    };
  },
});
