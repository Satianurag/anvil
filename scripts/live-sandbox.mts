/**
 * Live run of the sandbox routes (/v1/run, /v1/analyze, /v1/test) on Vercel Sandbox.
 * Requires VERCEL_* (after `pnpm sandbox:snapshot`) and GEMINI_API_KEY for analyze.
 */
import assert from "node:assert/strict";

// biome-ignore lint/suspicious/noExplicitAny: loose JSON assertions in a live script
type Json = any;

delete process.env.PAY_TO;
const { createAnvil } = await import("../src/anvil.ts");
const { sha256 } = await import("../src/lib/storage.ts");
const app = await createAnvil();

const post = async (path: string, body: unknown) => {
  const t = Date.now();
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
  console.log(`OK ${path} ${Date.now() - t}ms`, json.artifacts.map((a: { name: string }) => a.name).join(" "));
  return json.result as Json;
};

const py = await post("/v1/run", {
  code: [
    "import matplotlib.pyplot as plt, urllib.request",
    "plt.plot([1,2,3],[1,4,9]); plt.savefig('output/chart.png')",
    "open('output/data.csv','w').write('x,y\\n1,1\\n')",
    "print(6*7)",
    "try:\n    urllib.request.urlopen('https://example.com', timeout=5); print('NET')\nexcept Exception: print('NONET')",
  ].join("\n"),
});
assert.equal(py.exit_code, 0, py.stderr);
assert.match(py.stdout, /^42\nNONET/);
assert.deepEqual(py.files, ["output/chart.png", "output/data.csv"]);

const js = await post("/v1/run", { language: "javascript", code: "console.log([1,2,3].reduce((a,b)=>a+b))" });
assert.equal(js.stdout, "6\n");

const err = await post("/v1/run", { code: "raise ValueError('boom')" });
assert.equal(err.error.value, "ValueError: boom");

const slow = await post("/v1/run", { code: "import time; time.sleep(30)", timeout_seconds: 2 });
assert.equal(slow.error.name, "Timeout");

const csv = "month,y1958,y1959,y1960\nJAN,340,360,417\nFEB,318,342,391\nMAR,362,406,419\nJUL,491,548,622\n";
const an = await post("/v1/analyze", {
  file: { base64: Buffer.from(csv).toString("base64"), filename: "airtravel.csv" },
  question: "Which month had the largest growth from 1958 to 1960? Plot all years as lines.",
});
assert.equal(an.error, null, JSON.stringify(an.error));
assert.match(an.answer ?? "", /JUL/i);
assert.ok(
  an.files.some((f: string) => f.endsWith(".png")),
  JSON.stringify(an.files),
);

const t = await post("/v1/test", {
  repo: "https://github.com/pallets/itsdangerous",
  ref: "main",
  timeout_seconds: 300,
});
assert.match(t.commit, /^[0-9a-f]{40}$/);
assert.equal(t.passed, true, t.log_tail);
assert.ok(t.junit?.tests > 0, JSON.stringify(t.junit));
console.log(`  test: ${t.commit.slice(0, 8)} ${JSON.stringify(t.junit)} ${t.duration_seconds}s`);

for (const repo of ["https://github.com/google/uuid", "https://github.com/rust-lang/cfg-if"]) {
  const r = await post("/v1/test", { repo, timeout_seconds: 600 });
  assert.equal(r.passed, true, r.log_tail);
  console.log(`  test: ${repo} ${r.commit.slice(0, 8)} ${r.duration_seconds}s`);
}

console.log("LIVE SANDBOX PASSED");
process.exit(0);
