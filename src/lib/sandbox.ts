import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { config } from "../config.ts";

const docker = promisify(execFile);
const RESOLV = fileURLToPath(new URL("../../sandbox/resolv.conf", import.meta.url));
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

export type CommandResult = { stdout: string; stderr: string; exitCode: number; timedOut: boolean };

/** Runs `docker` with optional stdin, collecting output as buffers. */
function dockerIo(args: string[], stdin?: Uint8Array | string) {
  return new Promise<{ stdout: Buffer; stderr: Buffer; code: number }>((resolve, reject) => {
    const p = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), code: code ?? 1 }));
    p.stdin.end(stdin);
  });
}

export class Sandbox {
  constructor(readonly id: string) {}

  /** Runs a shell command; a nonzero exit is returned, not thrown. Timed-out commands exit 137. */
  async exec(command: string, opts: { cwd?: string; timeoutMs: number }): Promise<CommandResult> {
    const secs = Math.ceil(opts.timeoutMs / 1000);
    const r = await dockerIo([
      "exec",
      "-w",
      opts.cwd ?? "/work",
      this.id,
      "timeout",
      "-s",
      "KILL",
      String(secs),
      "bash",
      "-c",
      command,
    ]);
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), exitCode: r.code, timedOut: r.code === 137 };
  }

  async write(path: string, data: Uint8Array | string) {
    const r = await dockerIo(
      ["exec", "-i", this.id, "sh", "-c", `mkdir -p "$(dirname ${q(path)})" && cat > ${q(path)}`],
      data,
    );
    if (r.code !== 0) throw new Error(`sandbox write ${path}: ${r.stderr}`);
  }

  async read(path: string): Promise<Buffer | undefined> {
    const r = await dockerIo(["exec", this.id, "cat", path]);
    return r.code === 0 ? r.stdout : undefined;
  }

  /** Regular files directly inside `dir` (names only). */
  async list(dir: string) {
    const r = await dockerIo(["exec", this.id, "find", dir, "-maxdepth", "1", "-type", "f", "-printf", "%f\\n"]);
    return r.code === 0 ? r.stdout.toString().split("\n").filter(Boolean).sort() : [];
  }
}

/**
 * Runs `fn` in a fresh throwaway container (gVisor runtime, no capabilities, resource limits) that is always
 * removed afterwards. `network: false` gives no network at all; `true` uses the egress-only SANDBOX_NETWORK.
 */
export async function withSandbox<T>(
  opts: { timeoutMs: number; network?: boolean },
  signal: AbortSignal,
  fn: (sbx: Sandbox) => Promise<T>,
) {
  const name = `anvil-sbx-${randomUUID()}`;
  await docker("docker", [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    `--runtime=${config.SANDBOX_RUNTIME}`,
    ...(opts.network
      ? [`--network=${config.SANDBOX_NETWORK}`, `--volume=${RESOLV}:/etc/resolv.conf:ro`]
      : ["--network=none"]),
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--memory=${config.SANDBOX_MEMORY}`,
    `--cpus=${config.SANDBOX_CPUS}`,
    "--pids-limit=512",
    "--label=anvil-sandbox",
    config.SANDBOX_IMAGE,
    "sleep",
    String(Math.ceil(opts.timeoutMs / 1000)),
  ]);
  const kill = () => docker("docker", ["rm", "-f", name]).catch(() => undefined);
  signal.addEventListener("abort", kill);
  try {
    return await fn(new Sandbox(name));
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
