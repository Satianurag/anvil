import { Defuddle } from "defuddle/node";
import { parseHTML } from "linkedom";
import { type BrowserContext, chromium, type Page } from "playwright-core";
import { config } from "../config.ts";
import { Semaphore, withLimit } from "./limiter.ts";
import { assertPublicUrl } from "./ssrf.ts";

export interface PageOptions {
  viewport?: { width: number; height: number };
  signal: AbortSignal;
}

const sem = new Semaphore(config.BROWSER_CONCURRENCY);

/** Opens a fresh context on the remote browser where every request (incl. redirects/subresources) passes the SSRF policy. */
export async function withPage<T>(
  opts: PageOptions,
  fn: (page: Page, context: BrowserContext) => Promise<T>,
): Promise<T> {
  return withLimit(sem, () => withPageInner(opts, fn));
}

async function withPageInner<T>(
  opts: PageOptions,
  fn: (page: Page, context: BrowserContext) => Promise<T>,
): Promise<T> {
  const browser = await chromium.connect(config.BROWSER_WS_URL, { timeout: 15_000 });
  const onAbort = () => void browser.close();
  opts.signal.addEventListener("abort", onAbort);
  try {
    const context = await browser.newContext({
      viewport: opts.viewport ?? { width: 1440, height: 900 },
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    await context.route("**/*", async (route) => {
      try {
        await assertPublicUrl(route.request().url());
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    return await fn(await context.newPage(), context);
  } finally {
    opts.signal.removeEventListener("abort", onAbort);
    await browser.close();
  }
}

/** Main-content markdown of an HTML document (Defuddle). */
export async function htmlToMarkdown(html: string, url: string) {
  const { document } = parseHTML(html);
  const parsed = await Defuddle(document as unknown as Document, url, { markdown: true });
  return { title: parsed.title, markdown: parsed.contentMarkdown ?? parsed.content };
}
