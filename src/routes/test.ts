import { z } from "zod";
import { type Artifact, defineJob, JobInputError } from "../lib/job.ts";
import { withSandbox } from "../lib/sandbox.ts";

const DIR = "/work/repo";

/** Picks install + test commands from the repository layout when the caller does not specify them. */
const DETECT = `set -e
if [ -f package.json ]; then
  if [ -f pnpm-lock.yaml ]; then echo "corepack enable >/dev/null 2>&1; pnpm install --frozen-lockfile|||pnpm test";
  elif [ -f yarn.lock ]; then echo "corepack enable >/dev/null 2>&1; yarn install --frozen-lockfile|||yarn test";
  else echo "npm ci || npm install|||npm test"; fi
elif [ -f pyproject.toml ] || [ -f setup.py ] || [ -f requirements.txt ]; then
  echo 'pip install -q pytest; [ -f requirements.txt ] && pip install -q -r requirements.txt; if [ -f pyproject.toml ] || [ -f setup.py ]; then pip install -q -e ".[test,tests]" || pip install -q -e .; fi; for g in test tests dev; do pip install -q --group $g 2>/dev/null; done; true|||python -m pytest --junitxml=junit.xml -q'
else echo "|||"; fi`;

function junitSummary(xml: string) {
  const suites = xml.match(/<testsuite\b[^>]*>/g) ?? [];
  if (!suites.length) return null;
  const sum = (n: string) =>
    suites.reduce((t, tag) => t + Number(new RegExp(`\\b${n}="(\\d+)"`).exec(tag)?.[1] ?? 0), 0);
  return { tests: sum("tests"), failures: sum("failures"), errors: sum("errors"), skipped: sum("skipped") };
}

export const test = defineJob({
  path: "/v1/test",
  price: "$0.25",
  description:
    "CI-as-a-call: clones a public git repository at an exact commit/branch/tag inside a fresh gVisor-sandboxed container (egress to public internet only), installs dependencies, runs its test suite (auto-detected for Node or Python, or your command) and returns pass/fail, the resolved commit SHA, JUnit XML and full logs as hashed evidence.",
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
    return withSandbox({ timeoutMs: (input.timeout_seconds * 2 + 180) * 1000, network: true }, signal, async (sbx) => {
      const started = Date.now();
      const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const clone = await sbx.exec(
        `git init -q ${DIR} && cd ${DIR} && git remote add origin ${q(input.repo)} && git fetch -q --depth 1 origin ${q(input.ref)} && git checkout -q FETCH_HEAD && git rev-parse HEAD`,
        { timeoutMs: 120_000 },
      );
      if (clone.exitCode !== 0) {
        throw new JobInputError(`git fetch of ${input.repo}@${input.ref} failed: ${clone.stderr.slice(-500)}`);
      }
      const commit = clone.stdout.trim().split("\n").pop() ?? "";
      const [detInstall, detTest] = (await sbx.exec(DETECT, { cwd: DIR, timeoutMs: 10_000 })).stdout
        .trim()
        .split("|||");
      const installCmd = input.install ?? detInstall;
      const testCmd = input.command ?? detTest;
      if (!testCmd) {
        throw new JobInputError("could not detect a test command; pass `command`");
      }
      const install = installCmd
        ? await sbx.exec(installCmd, { cwd: DIR, timeoutMs: input.timeout_seconds * 1000 })
        : undefined;
      const run = await sbx.exec(testCmd, { cwd: DIR, timeoutMs: input.timeout_seconds * 1000 });
      const junitXml = (await sbx.read(`${DIR}/${input.junit_path}`))?.toString();
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
          timed_out: run.timedOut,
          junit: junitXml ? junitSummary(junitXml) : null,
          duration_seconds: Math.round((Date.now() - started) / 100) / 10,
          log_tail: log.slice(-4000),
        },
        artifacts,
      };
    });
  },
});
