import { Daytona, type Sandbox as DaytonaSandbox } from "@daytona/sdk";
import { config, requireEnv } from "../config.ts";

const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
let client: Daytona | undefined;

export type CommandResult = { stdout: string; stderr: string; exitCode: number; timedOut: boolean };

/** Thin adapter over a Daytona sandbox with separate stdout/stderr and hard command timeouts. */
export class Sandbox {
  constructor(readonly sbx: DaytonaSandbox) {}

  /** Runs a shell command; a nonzero exit is returned, not thrown. Timed-out commands exit 137. */
  async exec(command: string, opts: { cwd?: string; timeoutMs: number }): Promise<CommandResult> {
    const secs = Math.ceil(opts.timeoutMs / 1000);
    const r = await this.sbx.process.executeCommand(
      `timeout -s KILL ${secs} bash -c ${q(command)} >/tmp/.anvil-out 2>/tmp/.anvil-err`,
      opts.cwd ?? "/work",
      undefined,
      secs + 30,
    );
    const [stdout, stderr] = await Promise.all([this.read("/tmp/.anvil-out"), this.read("/tmp/.anvil-err")]);
    return {
      stdout: stdout?.toString() ?? "",
      stderr: stderr?.toString() ?? "",
      exitCode: r.exitCode,
      timedOut: r.exitCode === 137,
    };
  }

  async write(path: string, data: Uint8Array | string) {
    await this.sbx.process.executeCommand(`mkdir -p "$(dirname ${q(path)})"`);
    await this.sbx.fs.uploadFile(Buffer.from(data), path);
  }

  async read(path: string): Promise<Buffer | undefined> {
    return this.sbx.fs.downloadFile(path).catch(() => undefined);
  }

  /** Regular files directly inside `dir` (names only). */
  async list(dir: string) {
    const files = await this.sbx.fs.listFiles(dir).catch(() => []);
    return files
      .filter((f) => !f.isDir)
      .map((f) => f.name)
      .sort();
  }
}

/**
 * Runs `fn` in a fresh ephemeral Daytona sandbox (from DAYTONA_SNAPSHOT) that is always deleted afterwards.
 * `network: false` blocks all outbound traffic; `true` keeps the organisation's default egress policy.
 */
export async function withSandbox<T>(
  opts: { timeoutMs: number; network?: boolean },
  signal: AbortSignal,
  fn: (sbx: Sandbox) => Promise<T>,
) {
  requireEnv("DAYTONA_API_KEY");
  client ??= new Daytona({ apiKey: config.DAYTONA_API_KEY, apiUrl: config.DAYTONA_API_URL });
  const sbx = await client.create(
    {
      snapshot: config.DAYTONA_SNAPSHOT,
      ephemeral: true,
      autoStopInterval: Math.ceil(opts.timeoutMs / 60_000) + 1,
      ttlMinutes: Math.ceil(opts.timeoutMs / 60_000) + 5,
      networkBlockAll: !opts.network,
      labels: { app: "anvil" },
    },
    { timeout: 120 },
  );
  const kill = () => sbx.delete().catch(() => undefined);
  signal.addEventListener("abort", kill);
  try {
    return await fn(new Sandbox(sbx));
  } finally {
    signal.removeEventListener("abort", kill);
    await kill();
  }
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

/** Up to 20 files from `dir` as `output/<name>` artifacts. */
export async function collectOutputs(sbx: Sandbox, dir: string) {
  const names = (await sbx.list(dir)).slice(0, 20);
  const files = await Promise.all(names.map((n) => sbx.read(`${dir}/${n}`)));
  return names.flatMap((n, i) => {
    const body = files[i];
    const ext = n.split(".").pop()?.toLowerCase() ?? "";
    return body ? [{ name: `output/${n}`, contentType: TYPES[ext] ?? "application/octet-stream", body }] : [];
  });
}
