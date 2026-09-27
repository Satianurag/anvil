import { z } from "zod";
import { config, requireEnv } from "../config.ts";
import { type Artifact, defineJob, JobInputError } from "../lib/job.ts";
import { generateJson } from "../lib/llm.ts";
import { safeFetch } from "../lib/safe-fetch.ts";
import { collectOutputs, lastLine, withSandbox } from "../lib/sandbox.ts";

const MAX_BYTES = 50 * 1024 * 1024;
const OUT = "/work/output";

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
    "Data analysis as a call: send a CSV/TSV/JSON/Parquet/Excel dataset and a question; Gemini writes pandas/matplotlib code, it runs in a fresh Vercel Sandbox Firecracker microVM with no network (with one self-repair attempt), and you get the answer, the exact code, charts and transformed files as hashed artifacts.",
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

    return withSandbox({ timeoutMs: 200_000 }, signal, async (sbx) => {
      const path = `/work/${data.name}`;
      await sbx.write(path, new Uint8Array(data.body));
      await sbx.write("/work/profile.py", PROFILE(path));
      await sbx.exec(`mkdir -p ${OUT}`, { timeoutMs: 10_000 });
      const profileRun = await sbx.exec("python3 profile.py", { timeoutMs: 60_000 });
      if (profileRun.exitCode !== 0) throw new JobInputError(`could not parse dataset: ${lastLine(profileRun.stderr)}`);
      const profile = profileRun.stdout;

      let attempt: { code: string; explanation: string } | undefined;
      let execution: Awaited<ReturnType<typeof sbx.exec>> | undefined;
      let feedback = "";
      for (let i = 0; i < 2; i++) {
        attempt = await generateJson<{ code: string; explanation: string }>(
          [
            "Write one self-contained Python 3 script (pandas, numpy, scipy, matplotlib, seaborn available) that answers the question about the dataset.",
            `The dataset is at ${JSON.stringify(path)}. Profile (rows, dtypes, first rows as CSV): ${profile}`,
            `Save every chart with plt.savefig and every derived table as CSV into ${OUT}/ (descriptive file names).`,
            "Print the final answer on the last line prefixed with 'ANSWER: '. There is no network access.",
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
        await sbx.write("/work/analysis.py", attempt.code);
        execution = await sbx.exec("python3 analysis.py", { timeoutMs: 90_000 });
        if (execution.exitCode === 0) break;
        feedback = `Your previous code failed (exit ${execution.exitCode}):\n${execution.stderr.slice(-1500)}\nFix it.`;
      }
      if (!attempt || !execution) throw new Error("no analysis produced");

      const stdout = execution.stdout;
      const outputs = await collectOutputs(sbx, OUT);
      const artifacts: Artifact[] = [
        { name: "analysis.py", contentType: "text/x-python; charset=utf-8", body: attempt.code },
        { name: "stdout.txt", contentType: "text/plain; charset=utf-8", body: stdout },
        ...outputs,
      ];
      return {
        result: {
          answer: /ANSWER:\s*(.*)$/m.exec(stdout)?.[1]?.trim() ?? null,
          explanation: attempt.explanation,
          code: attempt.code,
          stdout: stdout.slice(-8000),
          error:
            execution.exitCode !== 0 ? { exit_code: execution.exitCode, stderr: execution.stderr.slice(-2000) } : null,
          files: outputs.map((o) => o.name),
          model: config.GEMINI_MODEL,
        },
        artifacts,
      };
    });
  },
});
