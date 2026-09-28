import { marked } from "marked";
import { config } from "../config.ts";
import { withPage } from "./browser.ts";

const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/** Tagged template that HTML-escapes interpolated values (arrays are joined; use `raw()` for trusted HTML). */
export function html(strings: TemplateStringsArray, ...values: unknown[]) {
  return strings.reduce((out, s, i) => {
    const v = values[i - 1];
    const text = Array.isArray(v)
      ? v.map((x) => (x instanceof Raw ? x.value : esc(x))).join("")
      : v instanceof Raw
        ? v.value
        : esc(v);
    return out + text + s;
  });
}
class Raw {
  constructor(readonly value: string) {}
}
export const raw = (value: string) => new Raw(value);

export const BASE_CSS = `body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:32px;font-size:12px;line-height:1.45}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}
code{font-family:ui-monospace,monospace;font-size:10px;word-break:break-all}.muted{color:#666}`;

async function gotenberg(route: string, files: Record<string, string | Uint8Array>, signal: AbortSignal) {
  const form = new FormData();
  for (const [name, body] of Object.entries(files))
    form.append("files", new Blob([typeof body === "string" ? body : new Uint8Array(body)]), name);
  form.append("printBackground", "true");
  const res = await fetch(new URL(route, config.GOTENBERG_URL), { method: "POST", body: form, signal });
  if (!res.ok) throw new Error(`gotenberg HTTP ${res.status}: ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Chromium print-to-PDF on the shared remote browser (the no-Gotenberg path). */
async function playwrightPdf(doc: string, signal: AbortSignal, assets: Record<string, Uint8Array>) {
  return withPage({ signal }, async (page) => {
    const names = Object.keys(assets);
    if (names.length)
      await page.route("**/*", async (route) => {
        const name = names.find((n) => new URL(route.request().url()).pathname.endsWith(`/${n}`));
        if (name) await route.fulfill({ body: Buffer.from(assets[name]) });
        else await route.continue();
      });
    await page.setContent(doc, { waitUntil: "load" });
    return new Uint8Array(await page.pdf({ printBackground: true, format: "A4" }));
  });
}

/** Renders a self-contained HTML document to PDF — Gotenberg when configured, else the remote browser. */
export const htmlToPdf = (doc: string, signal: AbortSignal, assets: Record<string, Uint8Array> = {}) =>
  config.GOTENBERG_URL
    ? gotenberg("/forms/chromium/convert/html", { "index.html": doc, ...assets }, signal)
    : playwrightPdf(doc, signal, assets);

/** Renders Markdown to PDF — Gotenberg's markdown route, else marked + the remote browser. */
export const markdownToPdf = async (markdown: string, title: string, signal: AbortSignal) => {
  if (config.GOTENBERG_URL)
    return gotenberg(
      "/forms/chromium/convert/markdown",
      {
        "index.html": html`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${raw(BASE_CSS)}</style></head><body>{{ toHTML "content.md" }}</body></html>`,
        "content.md": markdown,
      },
      signal,
    );
  const body = await marked.parse(markdown);
  return playwrightPdf(
    html`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${raw(BASE_CSS)}</style></head><body>${raw(body)}</body></html>`,
    signal,
    {},
  );
};
