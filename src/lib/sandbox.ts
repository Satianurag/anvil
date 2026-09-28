import { type NetworkPolicy, Sandbox as VercelSandbox } from "@vercel/sandbox";
import { config, requireEnv } from "../config.ts";
import { Semaphore, withLimit } from "./limiter.ts";

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const sem = new Semaphore(config.SANDBOX_CONCURRENCY);

/** Egress for /v1/test: git hosts and package registries only. */
const REGISTRIES: NetworkPolicy = {
  allow: [
    "github.com",
    "*.github.com",
    "*.githubusercontent.com",
    "gitlab.com",
    "*.gitlab.com",
    "bitbucket.org",
    "codeberg.org",
    "registry.npmjs.org",
    "registry.yarnpkg.com",
    "pypi.org",
    "files.pythonhosted.org",
    "proxy.golang.org",
    "sum.golang.org",
    "storage.googleapis.com",
    "crates.io",
    "index.crates.io",
    "static.crates.io",
  ],
};

export type CommandResult = { stdout: string; stderr: string; exitCode: number; timedOut: boolean };

/** Thin adapter over a Vercel Sandbox microVM with hard command timeouts. */
export class Sandbox {
  constructor(readonly sbx: VercelSandbox) {}

  /** Runs a shell command; a nonzero exit is returned, not thrown. Timed-out commands exit 124 or 137. */
  async exec(command: string, opts: { cwd?: string; timeoutMs: number }): Promise<CommandResult> {
    const secs = Math.ceil(opts.timeoutMs / 1000);
    const r = await this.sbx.runCommand({
      cmd: "timeout",
      args: ["-s", "KILL", String(secs), "bash", "-c", command],
      cwd: opts.cwd ?? "/work",
    });
    const [stdout, stderr] = await Promise.all([r.stdout(), r.stderr()]);
    return { stdout, stderr, exitCode: r.exitCode, timedOut: r.exitCode === 124 || r.exitCode === 137 };
  }

  async write(path: string, data: Uint8Array | string) {
    await this.exec(`mkdir -p "$(dirname ${q(path)})"`, { timeoutMs: 10_000 });
    await this.sbx.writeFiles([{ path, content: data }]);
  }

  async read(path: string): Promise<Buffer | undefined> {
    return (await this.sbx.readFileToBuffer({ path }).catch(() => null)) ?? undefined;
  }

  /** Regular files directly inside `dir` (names only). */
  async list(dir: string) {
    const r = await this.exec(`find ${q(dir)} -maxdepth 1 -type f -printf '%f\\n'`, { timeoutMs: 10_000 });
    return r.exitCode === 0 ? r.stdout.split("\n").filter(Boolean).sort() : [];
  }
}

/**
 * Runs `fn` in a fresh Firecracker microVM (Vercel Sandbox, booted from VERCEL_SANDBOX_SNAPSHOT) that is always
 * stopped afterwards. `network: false` denies all egress; `true` allows only git hosts and package registries.
 */
export async function withSandbox<T>(
  opts: { timeoutMs: number; network?: boolean },
  signal: AbortSignal,
  fn: (sbx: Sandbox) => Promise<T>,
) {
  // Vercel Sandbox microVMs are the most expensive resource a request can spawn — cap how many run at once.
  return withLimit(sem, async () => {
    const sbx = await VercelSandbox.create({
      token: requireEnv("VERCEL_TOKEN"),
      teamId: requireEnv("VERCEL_TEAM_ID"),
      projectId: requireEnv("VERCEL_PROJECT_ID"),
      source: { type: "snapshot", snapshotId: requireEnv("VERCEL_SANDBOX_SNAPSHOT") },
      resources: { vcpus: 2 },
      timeout: opts.timeoutMs + 60_000,
      networkPolicy: opts.network ? REGISTRIES : "deny-all",
      persistent: false,
      tags: { app: "anvil" },
      signal,
    });
    const stop = () => sbx.stop().catch(() => undefined);
    signal.addEventListener("abort", stop);
    try {
      return await fn(new Sandbox(sbx));
    } finally {
      signal.removeEventListener("abort", stop);
      await stop();
    }
  });
}

export const lastLine = (s: string) => s.trim().split("\n").pop() ?? "";

const TYPES: Record<string, string> = {
  png: "image/png",
  svg: "image/svg+xml",
  csv: "text/csv",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8",
  md: "text/markdown; charset=utf-8",
};

/** Up to 20 files from `dir` as `output/<name>` artifacts, each under MAX_ARTIFACT_BYTES. */
export async function collectOutputs(sbx: Sandbox, dir: string) {
  const capK = Math.floor(config.MAX_ARTIFACT_BYTES / 1024);
  const names = (
    await sbx.exec(`find ${q(dir)} -maxdepth 1 -type f -size -${capK}k -printf '%f\\n'`, { timeoutMs: 10_000 })
  ).stdout
    .split("\n")
    .filter(Boolean)
    .sort()
    .slice(0, 20);
  const files = await Promise.all(names.map((n) => sbx.read(`${dir}/${n}`)));
  return names.flatMap((n, i) => {
    const body = files[i];
    const ext = n.split(".").pop()?.toLowerCase() ?? "";
    return body ? [{ name: `output/${n}`, contentType: TYPES[ext] ?? "application/octet-stream", body }] : [];
  });
}
