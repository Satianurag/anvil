import { z } from "zod";

const NETWORKS = {
  mainnet: {
    caip2: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    usdc: "31566704",
    algod: "https://mainnet-api.4160.nodely.dev",
    indexer: "https://mainnet-idx.4160.nodely.dev",
  },
  testnet: {
    caip2: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
    usdc: "10458941",
    algod: "https://testnet-api.4160.nodely.dev",
    indexer: "https://testnet-idx.4160.nodely.dev",
  },
} as const;

const env = z
  .object({
    PORT: z.coerce.number().default(4021),
    PUBLIC_URL: z.url().default("http://localhost:4021"),
    ALGORAND_NETWORK: z.enum(["mainnet", "testnet"]).default("testnet"),
    PAY_TO: z.string().length(58).optional(),
    USDC_ASA: z.string().optional(),
    FACILITATOR_URL: z.url().default("https://facilitator.goplausible.xyz"),
    ALGOD_URL: z.url().optional(),
    ALGOD_TOKEN: z.string().default(""),
    INDEXER_URL: z.url().optional(),
    RECEIPT_MNEMONIC: z.string().optional(),
    S3_ENDPOINT: z.url().optional(),
    S3_REGION: z.string().default("auto"),
    S3_BUCKET: z.string().default("anvil"),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    STORAGE_CAP_BYTES: z.coerce.number().positive().optional(),
    ARTIFACT_URL_TTL_SECONDS: z.coerce.number().default(7 * 24 * 3600),
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().default("gemini-3.1-flash-lite"),
    GEMINI_SEARCH_MODEL: z.string().default("gemini-2.5-flash"),
    VERCEL_TOKEN: z.string().optional(),
    VERCEL_TEAM_ID: z.string().optional(),
    VERCEL_PROJECT_ID: z.string().optional(),
    VERCEL_SANDBOX_SNAPSHOT: z.string().optional(),
    DOCLING_URL: z.url().default("http://localhost:5001"),
    // PDF rendering backend: Gotenberg when set, else the shared remote browser prints the PDF.
    GOTENBERG_URL: z.url().optional(),
    PAGESPEED_API_KEY: z.string().optional(),
    MONITOR_TICK_SECONDS: z.coerce.number().default(60),
    BROWSER_WS_URL: z.url().default("ws://localhost:3001/"),
    ALLOW_PRIVATE_TARGETS: z.stringbool().default(false),
    // Max request body bytes (covers the largest legit input: ~20 MB base64 file + JSON overhead).
    MAX_BODY_BYTES: z.coerce.number().default(33_554_432),
    // Per-artifact byte cap; larger text artifacts are truncated, larger binaries are dropped.
    MAX_ARTIFACT_BYTES: z.coerce.number().default(33_554_432),
    // Concurrency caps: all jobs, Vercel Sandbox microVMs, remote-browser sessions.
    JOB_CONCURRENCY: z.coerce.number().default(4),
    SANDBOX_CONCURRENCY: z.coerce.number().default(2),
    BROWSER_CONCURRENCY: z.coerce.number().default(4),
  })
  .parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")));

if (env.ALGORAND_NETWORK === "mainnet" && /^(https?:\/\/)?(localhost|127\.|\[?::1\]?|0\.0\.0\.0)/.test(env.PUBLIC_URL))
  throw new Error("PUBLIC_URL must be your public HTTPS domain when ALGORAND_NETWORK=mainnet");

const net = NETWORKS[env.ALGORAND_NETWORK];

export const config = {
  ...env,
  network: net.caip2,
  usdcAsa: env.USDC_ASA ?? net.usdc,
  algodUrl: env.ALGOD_URL ?? net.algod,
  indexerUrl: env.INDEXER_URL ?? net.indexer,
};

export function requireEnv<K extends keyof typeof config>(key: K): NonNullable<(typeof config)[K]> {
  const value = config[key];
  if (value === undefined || value === "") throw new Error(`${String(key)} is not configured`);
  return value as NonNullable<(typeof config)[K]>;
}
