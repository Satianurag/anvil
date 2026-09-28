import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { jobs } from "../src/routes/index.ts";

const app = createApp(jobs);
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("request limits and input quality", () => {
  it("rejects oversized bodies with 413 before any handler runs", async () => {
    const res = await post("/v1/run", { language: "python", code: "x".repeat(40 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  it("rejects an invalid JSON Schema with 422 before payment", async () => {
    const res = await post("/v1/extract", { url: "https://example.com/a.pdf", schema: { type: 123 } });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(JSON.stringify(body)).toContain("invalid JSON Schema");
  });

  it("accepts a well-formed schema past input validation", async () => {
    const res = await post("/v1/extract", { url: "https://example.com/a.pdf", schema: { type: "object" } });
    // Passes validation; fails downstream only because no Gemini key is configured in tests.
    expect(res.status).not.toBe(422);
  });
});
