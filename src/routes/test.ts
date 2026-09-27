import { CommandExitError, type CommandResult } from "@e2b/code-interpreter";
import { z } from "zod";
import { type Artifact, defineJob, JobInputError } from "../lib/job.ts";
import { withSandbox } from "../lib/sandbox.ts";

const DIR = "/home/user/repo";

/** Picks install + test commands from the repository layout when the caller does not specify them. */
const DETECT = `set -e
if [ -f package.json ]; then
  if [ -f pnpm-lock.yaml ]; then echo "corepack enable >/dev/null 2>&1; pnpm install --frozen-lockfile|||pnpm test";
  elif [ -f yarn.lock ]; then echo "corepack enable >/dev/null 2>&1; yarn install --frozen-lockfile|||yarn test";
  else echo "npm ci || npm install|||npm test"; fi
elif [ -f pyproject.toml ] || [ -f setup.py ] || [ -f requirements.txt ]; then
  echo "pip install -q pytest; [ -f requirements.txt ] && pip install -q -r requirements.txt; ([ -f pyproject.toml ] || [ -f setup.py ]) && pip install -q -e . || true|||python -m pytest --junitxml=junit.xml -q"
elif [ -f go.mod ]; then echo "go mod download|||go test ./... -v"
elif [ -f Cargo.toml ]; then echo "cargo fetch|||cargo test"
else echo "|||"; fi`;

const exec = async (p: Promise<CommandResult>) => {
  try {
    return await p;
  } catch (err) {
    if (err instanceof CommandExitError) return err;
    throw err;
  }
};

function junitSummary(xml: string) {
  const root = /<testsuites?\b[^>]*>/.exec(xml)?.[0] ?? "";
  const attr = (n: string) => Number(new RegExp(`\\b${n}="(\\d+)"`).exec(root)?.[1] ?? 0);
  if (!root) return null;
  return { tests: attr("tests"), failures: attr("failures"), errors: attr("errors"), skipped: attr("skipped") };
}

export const test = defineJob({
  path: "/v1/test",
  price: "$0.25",
  description:
    "CI-as-a-call: clones a public git repository at an exact commit/branch/tag inside a fresh E2B microVM, installs dependencies, runs its test suite (auto-detected for Node, Python, Go, Rust or your command) and returns pass/fail, the resolved commit SHA, JUnit XML and full logs as hashed evidence.",
  input: z.object({
    repo: z.url({ protocol: /^https$/ }).describe("Public HTTPS git URL, e.g. https://github.com/owner/repo"),
    ref: z
      .string()
      .regex(/^[\w./-]{1,200}$/)
      .default("HEAD")
      .describe("Branch, tag or commit SHA"),
    install: z.string().max(2000).optional().describe("Install command (auto-detected if omitted)"),
    command: z.string().max(2000).optional().describe("Test command (auto-detected if omitted)"),
    junit_path: z
      .string()
      .regex(/^[\w./-]{1,200}$/)
      .default("junit.xml")
      .describe("JUnit XML path relative to the repo root"),
    timeout_seconds: z.int().min(10).max(600).default(300),
  }),
  inputExample: { repo: "https://github.com/pallets/itsdangerous", ref: "main" },
  outputExample: {
    commit: "2f4e0b1…",
    command: "python -m pytest --junitxml=junit.xml -q",
    exit_code: 0,
    passed: true,
    junit: { tests: 312, failures: 0, errors: 0, skipped: 2 },
    duration_seconds: 41.2,
  },
  timeoutMs: 720_000,
  async run(input, signal) {
    return withSandbox((input.timeout_seconds + 120) * 1000, signal, async (sbx) => {
      const started = Date.now();
      const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const clone = await exec(
        sbx.commands.run(
          `git init -q ${DIR} && cd ${DIR} && git remote add origin ${q(input.repo)} && git fetch -q --depth 1 origin ${q(input.ref)} && git checkout -q FETCH_HEAD && git rev-parse HEAD`,
          { timeoutMs: 120_000 },
        ),
      );
      if (clone.exitCode !== 0) {
        throw new JobInputError(`git fetch of ${input.repo}@${input.ref} failed: ${clone.stderr.slice(-500)}`);
      }
      const commit = clone.stdout.trim().split("\n").pop() ?? "";
      const [detInstall, detTest] = (await sbx.commands.run(DETECT, { cwd: DIR })).stdout.trim().split("|||");
      const installCmd = input.install ?? detInstall;
      const testCmd = input.command ?? detTest;
      if (!testCmd) {
        throw new JobInputError("could not detect a test command; pass `command`");
      }
      const install = installCmd
        ? await exec(sbx.commands.run(installCmd, { cwd: DIR, timeoutMs: input.timeout_seconds * 1000 }))
        : undefined;
      const run = await exec(sbx.commands.run(testCmd, { cwd: DIR, timeoutMs: input.timeout_seconds * 1000 }));
      const junitXml = await sbx.files.read(`${DIR}/${input.junit_path}`).catch(() => undefined);
      const log = [
        `$ ${installCmd}`,
        install?.stdout,
        install?.stderr,
        `[exit ${install?.exitCode ?? "-"}]`,
        `$ ${testCmd}`,
        run.stdout,
        run.stderr,
        `[exit ${run.exitCode}]`,
      ].join("\n");
      const artifacts: Artifact[] = [{ name: "test-log.txt", contentType: "text/plain; charset=utf-8", body: log }];
      if (junitXml) artifacts.push({ name: "junit.xml", contentType: "application/xml", body: junitXml });
      return {
        result: {
          repo: input.repo,
          ref: input.ref,
          commit,
          install_command: installCmd || null,
          install_exit_code: install?.exitCode ?? null,
          command: testCmd,
          exit_code: run.exitCode,
          passed: run.exitCode === 0,
          junit: junitXml ? junitSummary(junitXml) : null,
          duration_seconds: Math.round((Date.now() - started) / 100) / 10,
          log_tail: log.slice(-4000),
        },
        artifacts,
      };
    });
  },
});
