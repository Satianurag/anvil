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
    ARTIFACT_URL_TTL_SECONDS: z.coerce.number().default(7 * 24 * 3600),
    GEMINI_API_KEY: z.string().optional(),
    GEMINI_MODEL: z.string().default("gemini-3.1-flash-lite"),
    E2B_API_KEY: z.string().optional(),
    DOCLING_URL: z.url().default("http://localhost:5001"),
    BROWSER_WS_URL: z.url().default("ws://localhost:3001/"),
    ALLOW_PRIVATE_TARGETS: z.stringbool().default(false),
  })
  .parse(process.env);

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
