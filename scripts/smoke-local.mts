/**
 * Unpaid local smoke test of every job that needs no third-party API key, plus hash lookup and MCP.
 * Requires: `docker compose --profile dev up -d` (browser, docling, gotenberg, s3).
 */
import assert from "node:assert/strict";
import algosdk from "algosdk";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON assertions in a smoke script
type Json = any;

delete process.env.PAY_TO;
process.env.RECEIPT_MNEMONIC ||= algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);
const { createAnvil } = await import("../src/anvil.ts");
const { sha256 } = await import("../src/lib/storage.ts");
const { runCheck, monitorStatus } = await import("../src/routes/monitor.ts");
const app = await createAnvil();

const post = async (path: string, body: unknown) => {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Json;
  assert.equal(res.status, 200, `${path}: ${JSON.stringify(json).slice(0, 800)}`);
  for (const a of json.artifacts) {
    const bytes = new Uint8Array(await (await fetch(a.url)).arrayBuffer());
    assert.equal(sha256(bytes), a.sha256, `${path} ${a.name} hash`);
  }
  console.log(
    `OK ${path}`,
    json.artifacts.map((a: { name: string; bytes: number }) => `${a.name}:${a.bytes}`).join(" "),
  );
  return json;
};

const att = await post("/v1/attest", { content: "hello anvil", label: "smoke" });
assert.equal(att.result.sha256, sha256("hello anvil"));
const found = await (await app.request(`/v1/verify/hash/${att.result.sha256}`)).json();
assert.equal(found.found, true);
assert.ok(found.jobs.some((j: { job_id: string }) => j.job_id === att.job_id));
console.log("OK hash lookup");

const cert = await post("/v1/certify", {
  title: "Certificate of Completion",
  recipient: "Ada <Lovelace>",
  issuer: "Smoke Academy",
  fields: { Course: "x402 101" },
});
const pdf = cert.artifacts.find((a: { name: string }) => a.name === "certificate.pdf");
assert.equal(pdf.sha256, cert.result.pdf_sha256);
assert.ok(
  algosdk.verifyBytes(
    Buffer.from(cert.result.pdf_sha256, "hex"),
    Buffer.from(cert.result.signature, "base64"),
    cert.result.signer,
  ),
);
const certLookup = await (await app.request(`/v1/verify/hash/${cert.result.pdf_sha256}`)).json();
assert.equal(certLookup.found, true);
console.log("OK certificate signature verifies + hash lookup");

await post("/v1/evidence", { url: "https://example.com" });
const audit = await post("/v1/audit/site", { url: "https://example.com" });
console.log(
  "  lighthouse:",
  audit.result.scores ? "scored" : `degraded (${String(audit.result.lighthouse_error).slice(0, 80)})`,
);
assert.ok(audit.result.accessibility.engine.startsWith("axe-core"));
assert.ok(Array.isArray(audit.result.seo.issues));

const br = await post("/v1/browse/act", {
  url: "https://example.com",
  steps: [
    { action: "extract", name: "heading", selector: "h1" },
    { action: "screenshot", name: "start" },
    { action: "click", selector: "a" },
    { action: "extract", name: "title", selector: "h1" },
  ],
});
assert.equal(br.result.extracted.heading, "Example Domain");
assert.equal(br.result.completed, true, JSON.stringify(br.result.steps));

const mon = await post("/v1/monitor", { url: "https://example.com", interval_minutes: 15, checks: 2 });
const { getJson } = await import("../src/lib/storage.ts");
const record = await getJson<Json>(`monitors/${mon.result.monitor_id}.json`);
record.last_sha256 = "0".repeat(64);
record.last_lines = ["stale line"];
const check = await runCheck(record, AbortSignal.timeout(90_000));
assert.equal(check.changed, true);
assert.ok(check.added?.includes("Example Domain"));
const status = await monitorStatus(mon.result.monitor_id);
assert.equal(status?.checks_done, 1);
assert.ok(status?.history[0].screenshot_url);
console.log("OK monitor change detected");

const bad = await app.request("/v1/audit/site", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "http://169.254.169.254/" }),
});
assert.equal(bad.status, 422);

const rpc = async (method: string, params: unknown) => {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(res.status, 200);
  return ((await res.json()) as { result: Json }).result;
};
const list = await rpc("tools/list", {});
assert.ok(list.tools.length >= 15, `tools: ${list.tools.length}`);
const call = await rpc("tools/call", { name: "attest", arguments: { content: "via mcp" } });
assert.equal(JSON.parse(call.content[0].text).result.sha256, sha256("via mcp"));
console.log(`OK MCP (${list.tools.length} tools, attest call)`);
console.log("SMOKE PASSED");
process.exit(0);
