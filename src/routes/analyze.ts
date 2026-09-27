import { z } from "zod";
import { config, requireEnv } from "../config.ts";
import { type Artifact, defineJob, JobInputError } from "../lib/job.ts";
import { generateJson } from "../lib/llm.ts";
import { safeFetch } from "../lib/safe-fetch.ts";
import { withSandbox } from "../lib/sandbox.ts";

const MAX_BYTES = 50 * 1024 * 1024;
const OUT = "/home/user/output";

const PROFILE = (path: string) => `
import pandas as pd, json
p = ${JSON.stringify(path)}
ext = p.rsplit(".", 1)[-1].lower()
df = {"csv": pd.read_csv, "tsv": lambda f: pd.read_csv(f, sep="\\t"), "json": pd.read_json, "jsonl": lambda f: pd.read_json(f, lines=True),
      "parquet": pd.read_parquet, "xlsx": pd.read_excel, "xls": pd.read_excel}.get(ext, pd.read_csv)(p)
print(json.dumps({"rows": len(df), "columns": {c: str(t) for c, t in df.dtypes.items()}, "head": df.head(8).to_csv(index=False)}, default=str))
`;

export const analyze = defineJob({
  path: "/v1/analyze",
  price: "$0.10",
  description:
    "Data analysis as a call: send a CSV/TSV/JSON/Parquet/Excel dataset and a question; Gemini writes pandas/matplotlib code, it runs in a fresh E2B microVM (with one self-repair attempt), and you get the answer, the exact code, charts and transformed files as hashed artifacts.",
  input: z
    .object({
      url: z
        .url({ protocol: /^https?$/ })
        .optional()
        .describe("Public URL of the dataset"),
      file: z.object({ base64: z.base64(), filename: z.string().regex(/^[\w.-]{1,120}$/) }).optional(),
      question: z.string().min(3).max(4000).describe("What to compute, transform or chart"),
    })
    .refine((v) => !!v.url !== !!v.file, "provide exactly one of url or file"),
  inputExample: {
    url: "https://people.sc.fsu.edu/~jburkardt/data/csv/airtravel.csv",
    question: "Which month had the largest year-over-year growth? Plot all years as lines.",
  },
  outputExample: {
    answer: "July had the largest growth (+13.9%).",
    code: "import pandas as pd …",
    stdout: "…",
    files: ["chart.png", "growth.csv"],
  },
  timeoutMs: 240_000,
  async run(input, signal) {
    requireEnv("GEMINI_API_KEY");
    const data = input.file
      ? { name: input.file.filename, body: Buffer.from(input.file.base64, "base64") }
      : await safeFetch(input.url as string, MAX_BYTES, signal).then(({ url, body }) => ({
          name: (url.pathname.split("/").pop() || "data.csv").replace(/[^\w.-]/g, "_"),
          body,
        }));
    if (data.body.byteLength > MAX_BYTES) throw new JobInputError(`dataset exceeds ${MAX_BYTES} bytes`);

    return withSandbox(200_000, signal, async (sbx) => {
      const path = `/home/user/${data.name}`;
      await sbx.files.write(path, new Uint8Array(data.body).buffer as ArrayBuffer);
      await sbx.files.makeDir(OUT);
      const profileRun = await sbx.runCode(PROFILE(path), { timeoutMs: 60_000 });
      if (profileRun.error) throw new JobInputError(`could not parse dataset: ${profileRun.error.value}`);
      const profile = profileRun.logs.stdout.join("");

      let attempt: { code: string; explanation: string } | undefined;
      let execution: Awaited<ReturnType<typeof sbx.runCode>> | undefined;
      let feedback = "";
      for (let i = 0; i < 2; i++) {
        attempt = await generateJson<{ code: string; explanation: string }>(
          [
            "Write one self-contained Python 3 script (pandas, numpy, matplotlib available) that answers the question about the dataset.",
            `The dataset is at ${JSON.stringify(path)}. Profile (rows, dtypes, first rows as CSV): ${profile}`,
            `Save every chart with plt.savefig and every derived table as CSV into ${OUT}/ (descriptive file names).`,
            "Print the final answer on the last line prefixed with 'ANSWER: '. Do not access the network.",
            `Question: ${input.question}`,
            feedback,
          ].join("\n"),
          {
            type: "object",
            properties: { code: { type: "string" }, explanation: { type: "string" } },
            required: ["code", "explanation"],
          },
          signal,
        );
        execution = await sbx.runCode(attempt.code, { timeoutMs: 90_000 });
        if (!execution.error) break;
        feedback = `Your previous code failed with ${execution.error.name}: ${execution.error.value}\n${execution.error.traceback.slice(-1500)}\nFix it.`;
      }
      if (!attempt || !execution) throw new Error("no analysis produced");

      const stdout = execution.logs.stdout.join("");
      const artifacts: Artifact[] = [
        { name: "analysis.py", contentType: "text/x-python; charset=utf-8", body: attempt.code },
        { name: "stdout.txt", contentType: "text/plain; charset=utf-8", body: stdout },
      ];
      const entries = (await sbx.files.list(OUT)).filter((e) => e.type === "file").slice(0, 20);
      for (const e of entries) {
        const bytes = await sbx.files.read(e.path, { format: "bytes" });
        const type = e.name.endsWith(".png")
          ? "image/png"
          : e.name.endsWith(".csv")
            ? "text/csv"
            : "application/octet-stream";
        artifacts.push({ name: `output/${e.name}`, contentType: type, body: bytes });
      }
      return {
        result: {
          answer: /ANSWER:\s*(.*)$/m.exec(stdout)?.[1]?.trim() ?? null,
          explanation: attempt.explanation,
          code: attempt.code,
          stdout: stdout.slice(-8000),
          error: execution.error ? { name: execution.error.name, value: execution.error.value } : null,
          files: entries.map((e) => `output/${e.name}`),
          model: config.GEMINI_MODEL,
        },
        artifacts,
      };
    });
  },
});
