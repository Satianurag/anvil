import { z } from "zod";
import { type Artifact, defineJob } from "../lib/job.ts";
import { withSandbox } from "../lib/sandbox.ts";

export const run = defineJob({
  path: "/v1/run",
  price: "$0.05",
  description:
    "Isolated code execution: runs Python or JavaScript in a fresh Firecracker microVM (no state shared between calls) and returns stdout, stderr, errors and any produced charts/files as hashed artifacts.",
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
    results: [{ type: "image/png", artifact: "result-0.png" }],
  },
  timeoutMs: 150_000,
  async run(input, signal) {
    return withSandbox((input.timeout_seconds + 30) * 1000, signal, async (sbx) => {
      for (const f of input.files) await sbx.files.write(f.path, f.content);
      const execution = await sbx.runCode(input.code, {
        language: input.language,
        timeoutMs: input.timeout_seconds * 1000,
      });
      const stdout = execution.logs.stdout.join("");
      const stderr = execution.logs.stderr.join("");
      const artifacts: Artifact[] = [
        { name: "stdout.txt", contentType: "text/plain; charset=utf-8", body: stdout },
        { name: "stderr.txt", contentType: "text/plain; charset=utf-8", body: stderr },
      ];
      const results = execution.results.map((r, i) => {
        if (r.png) {
          const name = `result-${i}.png`;
          artifacts.push({ name, contentType: "image/png", body: Buffer.from(r.png, "base64") });
          return { type: "image/png", artifact: name };
        }
        return { type: r.json ? "application/json" : "text/plain", value: r.json ?? r.text ?? null };
      });
      return {
        result: {
          stdout,
          stderr,
          error: execution.error
            ? { name: execution.error.name, value: execution.error.value, traceback: execution.error.traceback }
            : null,
          results,
        },
        artifacts,
      };
    });
  },
});
