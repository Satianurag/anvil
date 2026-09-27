import { z } from "zod";
import { config } from "../config.ts";
import { withPage } from "../lib/browser.ts";
import { anchorNote, signWithReceiptKey } from "../lib/chain.ts";
import { defineJob } from "../lib/job.ts";
import { assertPublicUrl } from "../lib/ssrf.ts";
import { getJson, listKeys, putJson, putObject, sha256, signedUrl } from "../lib/storage.ts";

export const MONITOR_NOTE_PREFIX = "anvil/v1:m";

interface Check {
  n: number;
  at: string;
  sha256: string;
  changed: boolean;
  added?: string[];
  removed?: string[];
  screenshot_key?: string;
  content_key?: string;
  anchor_txid?: string;
  webhook_status?: number | string;
}
export interface Monitor {
  id: string;
  url: string;
  selector: string | null;
  interval_minutes: number;
  checks_total: number;
  checks_done: number;
  next_check_at: string;
  webhook_url: string | null;
  payment_txid: string | null;
  last_sha256: string;
  last_lines: string[];
  history: Check[];
}

const key = (id: string) => `monitors/${id}.json`;

async function capture(url: string, selector: string | null, signal: AbortSignal) {
  await assertPublicUrl(url);
  return withPage({ signal }, async (page) => {
    await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    const text = selector
      ? await page.locator(selector).first().innerText({ timeout: 15_000 })
      : await page.innerText("body");
    const lines = text
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const content = lines.join("\n");
    return {
      content,
      lines,
      sha256: sha256(content),
      screenshot: new Uint8Array(await page.screenshot({ type: "png" })),
    };
  });
}

/** One scheduled check: capture, diff against last state, store evidence, anchor + notify on change. */
export async function runCheck(m: Monitor, signal: AbortSignal) {
  const n = m.checks_done + 1;
  const at = new Date().toISOString();
  const cap = await capture(m.url, m.selector, signal);
  const check: Check = { n, at, sha256: cap.sha256, changed: cap.sha256 !== m.last_sha256 };
  if (check.changed) {
    const prev = new Set(m.last_lines);
    const next = new Set(cap.lines);
    check.added = cap.lines.filter((l) => !prev.has(l)).slice(0, 100);
    check.removed = m.last_lines.filter((l) => !next.has(l)).slice(0, 100);
    check.screenshot_key = `monitors/${m.id}/${n}/screenshot.png`;
    check.content_key = `monitors/${m.id}/${n}/content.txt`;
    await putObject(check.screenshot_key, cap.screenshot, "image/png");
    await putObject(check.content_key, cap.content, "text/plain; charset=utf-8");
    if (config.RECEIPT_MNEMONIC)
      check.anchor_txid = await anchorNote(MONITOR_NOTE_PREFIX, { m: m.id, n, h: cap.sha256 }).catch(() => undefined);
    if (m.webhook_url) {
      const body = JSON.stringify({ monitor_id: m.id, url: m.url, ...check, status_url: statusUrl(m.id) });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.RECEIPT_MNEMONIC) {
        const sig = signWithReceiptKey(Buffer.from(sha256(body), "hex"));
        headers["anvil-signer"] = sig.signer;
        headers["anvil-signature"] = sig.signature;
      }
      check.webhook_status = await assertPublicUrl(m.webhook_url)
        .then(() => fetch(m.webhook_url as string, { method: "POST", headers, body, redirect: "error", signal }))
        .then((r) => r.status)
        .catch((err: Error) => err.message);
    }
    m.last_lines = cap.lines;
    m.last_sha256 = cap.sha256;
  }
  m.checks_done = n;
  m.history.push(check);
  m.next_check_at = new Date(Date.now() + m.interval_minutes * 60_000).toISOString();
  await putJson(key(m.id), m);
  return check;
}

const statusUrl = (id: string) => new URL(`/v1/monitor/${id}`, config.PUBLIC_URL).href;

export const monitor = defineJob({
  path: "/v1/monitor",
  price: "$0.50",
  description:
    "Evidence-grade change monitoring: watches a public page (or one CSS selector) for up to 24 checks at your interval; every change is captured (screenshot + text), diffed, SHA-256 hashed, anchored on Algorand and pushed to your webhook with an Ed25519 signature. Free status at GET /v1/monitor/{id}.",
  input: z.object({
    url: z.url({ protocol: /^https?$/ }),
    selector: z.string().min(1).max(500).optional().describe("Watch only this element (Playwright selector)"),
    interval_minutes: z.int().min(15).max(1440).default(60),
    checks: z.int().min(1).max(24).default(24),
    webhook_url: z.url({ protocol: /^https$/ }).optional(),
  }),
  inputExample: { url: "https://example.com/pricing", interval_minutes: 60 },
  outputExample: {
    monitor_id: "6f1c…",
    status_url: "https://anvil.example/v1/monitor/6f1c…",
    baseline_sha256: "…",
    checks_total: 24,
    next_check_at: "2026-09-27T13:00:00.000Z",
  },
  timeoutMs: 90_000,
  async run(input, signal) {
    if (input.webhook_url) await assertPublicUrl(input.webhook_url);
    const cap = await capture(input.url, input.selector ?? null, signal);
    const id = crypto.randomUUID();
    const m: Monitor = {
      id,
      url: input.url,
      selector: input.selector ?? null,
      interval_minutes: input.interval_minutes,
      checks_total: input.checks,
      checks_done: 0,
      next_check_at: new Date(Date.now() + input.interval_minutes * 60_000).toISOString(),
      webhook_url: input.webhook_url ?? null,
      payment_txid: null,
      last_sha256: cap.sha256,
      last_lines: cap.lines,
      history: [],
    };
    await putJson(key(id), m);
    return {
      result: {
        monitor_id: id,
        status_url: statusUrl(id),
        url: input.url,
        selector: m.selector,
        baseline_sha256: cap.sha256,
        checks_total: m.checks_total,
        interval_minutes: m.interval_minutes,
        next_check_at: m.next_check_at,
      },
      artifacts: [
        { name: "baseline.png", contentType: "image/png", body: cap.screenshot },
        { name: "baseline.txt", contentType: "text/plain; charset=utf-8", body: cap.content },
      ],
    };
  },
});

export async function monitorStatus(id: string) {
  const m = await getJson<Monitor>(key(id));
  if (!m) return undefined;
  const { last_lines: _l, webhook_url: _w, ...rest } = m;
  return {
    ...rest,
    active: m.checks_done < m.checks_total,
    history: await Promise.all(
      m.history.map(async ({ screenshot_key, content_key, ...c }) => ({
        ...c,
        screenshot_url: screenshot_key ? await signedUrl(screenshot_key) : undefined,
        content_url: content_key ? await signedUrl(content_key) : undefined,
      })),
    ),
  };
}

const running = new Set<string>();

/** Runs every due check; call periodically. */
export async function tickMonitors(now = Date.now()) {
  const keys = (await listKeys("monitors/")).filter((k) => /^monitors\/[^/]+\.json$/.test(k));
  await Promise.all(
    keys.map(async (k) => {
      const m = await getJson<Monitor>(k);
      if (!m || m.checks_done >= m.checks_total || Date.parse(m.next_check_at) > now || running.has(m.id)) return;
      running.add(m.id);
      try {
        await runCheck(m, AbortSignal.timeout(90_000));
      } catch (err) {
        console.error(`monitor ${m.id} check failed`, err);
        m.next_check_at = new Date(now + m.interval_minutes * 60_000).toISOString();
        await putJson(k, m);
      } finally {
        running.delete(m.id);
      }
    }),
  );
}

export function startMonitorScheduler() {
  const timer = setInterval(
    () => void tickMonitors().catch((err) => console.error("monitor tick failed", err)),
    config.MONITOR_TICK_SECONDS * 1000,
  );
  timer.unref();
  return timer;
}
