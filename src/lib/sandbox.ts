import { Sandbox } from "@e2b/code-interpreter";
import { requireEnv } from "../config.ts";

/** Runs `fn` in a fresh E2B Firecracker sandbox that is always killed afterwards. */
export async function withSandbox<T>(timeoutMs: number, signal: AbortSignal, fn: (sbx: Sandbox) => Promise<T>) {
  const sbx = await Sandbox.create({ apiKey: requireEnv("E2B_API_KEY"), timeoutMs });
  const onAbort = () => void sbx.kill();
  signal.addEventListener("abort", onAbort);
  try {
    return await fn(sbx);
  } finally {
    signal.removeEventListener("abort", onAbort);
    await sbx.kill();
  }
}
