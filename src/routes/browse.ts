import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { withPage } from "../lib/browser.ts";
import { type Artifact, defineJob, JobInputError } from "../lib/job.ts";
import { assertPublicUrl } from "../lib/ssrf.ts";

const selector = z.string().min(1).max(500).describe("Playwright selector (CSS, text=…, role=…)");
const step = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), url: z.url({ protocol: /^https?$/ }) }),
  z.object({ action: z.literal("click"), selector }),
  z.object({ action: z.literal("fill"), selector, value: z.string().max(5000) }),
  z.object({ action: z.literal("select"), selector, value: z.string().max(500) }),
  z.object({ action: z.literal("press"), key: z.string().max(40), selector: selector.optional() }),
  z.object({ action: z.literal("wait_for"), selector: selector.optional(), ms: z.int().min(0).max(10_000).optional() }),
  z.object({ action: z.literal("scroll"), direction: z.enum(["down", "up"]).default("down") }),
  z.object({
    action: z.literal("extract"),
    name: z.string().regex(/^\w{1,40}$/),
    selector,
    attribute: z.string().max(60).optional().describe("Attribute to read instead of text"),
    all: z.boolean().default(false),
  }),
  z.object({
    action: z.literal("screenshot"),
    name: z.string().regex(/^\w{1,40}$/),
    full_page: z.boolean().default(false),
  }),
]);

export const browse = defineJob({
  path: "/v1/browse/act",
  price: "$0.25",
  description:
    "Scripted browser session: runs up to 25 steps (goto, click, fill, select, press, wait_for, scroll, extract, screenshot) in a real Chromium on public sites and returns extracted values, per-step results, screenshots and a Playwright trace as hashed evidence.",
  input: z.object({
    url: z.url({ protocol: /^https?$/ }),
    steps: z.array(step).min(1).max(25),
    viewport: z
      .object({ width: z.int().min(320).max(3840), height: z.int().min(240).max(2160) })
      .default({ width: 1440, height: 900 }),
  }),
  inputExample: {
    url: "https://example.com",
    steps: [
      { action: "extract", name: "heading", selector: "h1" },
      { action: "click", selector: "a" },
      { action: "screenshot", name: "after_click" },
    ],
  },
  outputExample: {
    final_url: "https://www.iana.org/help/example-domains",
    extracted: { heading: "Example Domain" },
    steps: [{ i: 0, action: "extract", ok: true }],
  },
  timeoutMs: 150_000,
  async run(input, signal) {
    await assertPublicUrl(input.url);
    return withPage({ viewport: input.viewport, signal }, async (page, context) => {
      page.setDefaultTimeout(15_000);
      await context.tracing.start({ screenshots: true, snapshots: true });
      const artifacts: Artifact[] = [];
      const extracted: Record<string, unknown> = {};
      const steps: { i: number; action: string; ok: boolean; url: string; error?: string }[] = [];
      await page.goto(input.url, { waitUntil: "load", timeout: 45_000 });
      for (const [i, s] of input.steps.entries()) {
        try {
          switch (s.action) {
            case "goto":
              await assertPublicUrl(s.url);
              await page.goto(s.url, { waitUntil: "load", timeout: 45_000 });
              break;
            case "click":
              await page.locator(s.selector).first().click();
              break;
            case "fill":
              await page.locator(s.selector).first().fill(s.value);
              break;
            case "select":
              await page.locator(s.selector).first().selectOption(s.value);
              break;
            case "press":
              await (s.selector ? page.locator(s.selector).first().press(s.key) : page.keyboard.press(s.key));
              break;
            case "wait_for":
              if (s.selector) await page.locator(s.selector).first().waitFor();
              else await page.waitForTimeout(s.ms ?? 1000);
              break;
            case "scroll":
              await page.mouse.wheel(0, s.direction === "down" ? 1000 : -1000);
              break;
            case "extract": {
              const loc = page.locator(s.selector);
              const read = (l: typeof loc) => (s.attribute ? l.getAttribute(s.attribute) : l.innerText());
              extracted[s.name] = s.all
                ? await Promise.all((await loc.all()).slice(0, 200).map(read))
                : await read(loc.first());
              break;
            }
            case "screenshot": {
              const png = await page.screenshot({ fullPage: s.full_page, type: "png" });
              artifacts.push({ name: `${s.name}.png`, contentType: "image/png", body: new Uint8Array(png) });
              break;
            }
          }
          await page.waitForLoadState("load");
          steps.push({ i, action: s.action, ok: true, url: page.url() });
        } catch (err) {
          if (err instanceof JobInputError) throw err;
          steps.push({ i, action: s.action, ok: false, url: page.url(), error: (err as Error).message.split("\n")[0] });
          break;
        }
      }
      const final = await page.screenshot({ type: "png" });
      const tracePath = join(tmpdir(), `anvil-trace-${crypto.randomUUID()}.zip`);
      await context.tracing.stop({ path: tracePath });
      const trace = new Uint8Array(await readFile(tracePath));
      await rm(tracePath, { force: true });
      artifacts.push(
        { name: "final.png", contentType: "image/png", body: new Uint8Array(final) },
        { name: "trace.zip", contentType: "application/zip", body: trace },
      );
      return {
        result: {
          final_url: page.url(),
          title: await page.title(),
          completed: steps.every((s) => s.ok) && steps.length === input.steps.length,
          extracted,
          steps,
          trace_viewer: "open trace.zip at https://trace.playwright.dev",
        },
        artifacts,
      };
    });
  },
});
