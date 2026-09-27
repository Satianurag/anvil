import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { jobs } from "../src/routes/index.ts";

const app = createApp(jobs);
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("app (unpaid dev mode)", () => {
  it("lists routes", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect((await res.json()).routes).toHaveLength(jobs.length);
  });

  it("rejects invalid input with 422", async () => {
    expect((await post("/v1/evidence", { url: "file:///etc/passwd" })).status).toBe(422);
    expect((await post("/v1/run", { language: "cobol", code: "x" })).status).toBe(422);
    expect((await post("/v1/extract", { schema: {} })).status).toBe(422);
  });

  it("rejects SSRF targets with 422", async () => {
    const res = await post("/v1/evidence", { url: "http://169.254.169.254/latest" });
    expect(res.status).toBe(422);
  });

  it("fails clearly when an integration is not configured", async () => {
    const res = await post("/v1/extract", { url: "https://example.com/a.pdf", schema: { type: "object" } });
    expect(res.status).toBe(500);
    expect((await res.json()).message).toBe("GEMINI_API_KEY is not configured");
  });

  it("validates txid format on /v1/verify", async () => {
    expect((await app.request("/v1/verify/not-a-txid")).status).toBe(400);
  });
});
