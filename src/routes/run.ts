import { z } from "zod";
import { type Artifact, defineJob } from "../lib/job.ts";
import { collectOutputs, lastLine, withSandbox } from "../lib/sandbox.ts";

export const run = defineJob({
  path: "/v1/run",
  price: "$0.05",
  description:
    "Isolated code execution: runs Python (pandas, numpy, scipy, matplotlib preinstalled) or JavaScript (Node 24) in a fresh gVisor-sandboxed container with no network and no state shared between calls, and returns stdout, stderr, exit code and every file written to ./output (charts, CSVs) as hashed artifacts.",
  input: z.object({
    language: z.enum(["python", "javascript"]).default("python"),
    code: z.string().min(1).max(100_000),
    files: z
      .array(
        z.object({
          path: z
            .string()
            .regex(/^[\w./-]+$/)
            .max(200),
          content: z.string().max(5_000_000),
        }),
      )
      .max(20)
      .default([])
      .describe("Text files written to the working directory before execution"),
    timeout_seconds: z.int().min(1).max(120).default(60),
  }),
  inputExample: { language: "python", code: "print(6 * 7)" },
  outputExample: {
    stdout: "42\n",
    stderr: "",
    error: null,
    exit_code: 0,
    files: ["output/chart.png"],
  },
  timeoutMs: 150_000,
  async run(input, signal) {
    return withSandbox({ timeoutMs: (input.timeout_seconds + 30) * 1000 }, signal, async (sbx) => {
      for (const f of input.files) await sbx.write(`/work/${f.path}`, f.content);
      const main = input.language === "python" ? "main.py" : "main.mjs";
      await sbx.write(`/work/${main}`, input.code);
      await sbx.exec("mkdir -p output", { timeoutMs: 10_000 });
      const r = await sbx.exec(`${input.language === "python" ? "python3" : "node"} ${main}`, {
        timeoutMs: input.timeout_seconds * 1000,
      });
      const artifacts: Artifact[] = [
        { name: "stdout.txt", contentType: "text/plain; charset=utf-8", body: r.stdout },
        { name: "stderr.txt", contentType: "text/plain; charset=utf-8", body: r.stderr },
        ...(await collectOutputs(sbx, "/work/output")),
      ];
      return {
        result: {
          stdout: r.stdout.slice(-50_000),
          stderr: r.stderr.slice(-50_000),
          exit_code: r.exitCode,
          error: r.timedOut
            ? { name: "Timeout", value: `exceeded ${input.timeout_seconds}s` }
            : r.exitCode !== 0
              ? { name: "Error", value: lastLine(r.stderr) }
              : null,
          files: artifacts.slice(2).map((a) => a.name),
        },
        artifacts,
      };
    });
  },
});
