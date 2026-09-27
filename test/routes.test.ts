import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { toolName } from "../src/mcp.ts";
import { jobs } from "../src/routes/index.ts";
import { paidRoutes } from "../src/x402.ts";

const app = createApp(jobs);
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const PAY_TO = "A".repeat(58);

describe("route catalogue", () => {
  it("registers every paid workflow with tag, Bazaar metadata and unique MCP tool names", () => {
    const routes = paidRoutes(jobs, PAY_TO) as unknown as Record<
      string,
      { accepts: { extra: { tag: string }; payTo: string }; extensions: { bazaar: unknown } }
    >;
    for (const p of [
      "/v1/audit/site",
      "/v1/research/brief",
      "/v1/test",
      "/v1/analyze",
      "/v1/monitor",
      "/v1/browse/act",
      "/v1/attest",
      "/v1/certify",
      "/v1/extract/invoice",
      "/v1/extract/bank-statement",
      "/v1/extract/resume-match",
      "/v1/compare",
    ]) {
      const r = routes[`POST ${p}`];
      expect(r, p).toBeDefined();
      expect(r.accepts.extra.tag).toBe("x402-global-challenge");
      expect(r.accepts.payTo).toBe(PAY_TO);
      expect(r.extensions.bazaar).toBeDefined();
    }
    expect(new Set(jobs.map(toolName)).size).toBe(jobs.length);
  });

  it("every input example satisfies its schema", () => {
    for (const j of jobs) expect(j.input.safeParse(j.inputExample).success, j.path).toBe(true);
  });
});

describe("input validation", () => {
  it.each([
    ["/v1/audit/site", { url: "ftp://x" }],
    ["/v1/research/brief", { topic: "x" }],
    ["/v1/test", { repo: "http://github.com/a/b" }],
    ["/v1/test", { repo: "https://github.com/a/b", ref: "main; rm -rf /" }],
    ["/v1/analyze", { question: "sum it" }],
    ["/v1/monitor", { url: "https://example.com", interval_minutes: 1 }],
    ["/v1/browse/act", { url: "https://example.com", steps: [{ action: "eval", script: "1" }] }],
    ["/v1/attest", { sha256: "zz" }],
    ["/v1/certify", { title: "t" }],
    ["/v1/extract/invoice", {}],
    ["/v1/extract/resume-match", { url: "https://example.com/cv.pdf" }],
  ])("%s rejects %j", async (path, body) => {
    expect((await post(path, body)).status).toBe(422);
  });

  it("blocks private targets on URL-consuming routes", async () => {
    for (const [path, body] of [
      ["/v1/audit/site", { url: "http://127.0.0.1/" }],
      ["/v1/browse/act", { url: "http://10.0.0.1/", steps: [{ action: "screenshot" }] }],
      ["/v1/monitor", { url: "http://[::1]/" }],
      ["/v1/monitor", { url: "https://example.com", webhook_url: "https://169.254.169.254/" }],
    ] as const)
      expect((await post(path, body)).status, path).toBe(422);
  });
});

describe("missing credentials fail clearly", () => {
  it.each([
    ["/v1/research/brief", { topic: "Algorand x402 adoption" }, "GEMINI_API_KEY"],
    ["/v1/analyze", { file: { base64: "YSxiCjEsMgo=", filename: "d.csv" }, question: "sum a" }, "GEMINI_API_KEY"],
    ["/v1/extract/invoice", { file: { base64: "JVBERi0=", filename: "i.pdf" } }, "GEMINI_API_KEY"],
    ["/v1/run", { code: "print(1)" }, "VERCEL_TOKEN"],
    ["/v1/test", { repo: "https://github.com/pallets/itsdangerous" }, "VERCEL_TOKEN"],
  ])("%s", async (path, body, key) => {
    const res = await post(path, body);
    expect(res.status).toBe(500);
    expect((await res.json()).message).toBe(`${key} is not configured`);
  });
});

describe("free lookups", () => {
  it("validates hash format", async () => {
    expect((await app.request("/v1/verify/hash/nothex")).status).toBe(400);
  });
});
