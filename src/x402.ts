import { ExactAvmScheme } from "@x402/avm/exact/server";
import {
  type FacilitatorClient,
  HTTPFacilitatorClient,
  type RoutesConfig,
  x402ResourceServer,
} from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { z } from "zod";
import { config } from "./config.ts";
import type { JobDefinition } from "./lib/job.ts";

export const CHALLENGE_TAG = "x402-global-challenge";
/** Settle before running the job: the AVM client signs with a ~10-round validity window, shorter than long jobs. */
export const PAYMENT_EXTRA = { tag: CHALLENGE_TAG, paymentFlow: "upfront" };

export function createResourceServer(
  facilitator: FacilitatorClient = new HTTPFacilitatorClient({ url: config.FACILITATOR_URL }),
) {
  // GoPlausible advertises full-genesis-hash CAIP-2 ids, so USD prices are mapped to the USDC ASA explicitly.
  const scheme = new ExactAvmScheme().registerMoneyParser(async (amount) => ({
    amount: Math.round(Number(amount) * 1e6).toString(),
    asset: config.usdcAsa,
  }));
  return new x402ResourceServer(facilitator).register(config.network, scheme);
}

export function paidRoutes(jobs: JobDefinition[], payTo: string): RoutesConfig {
  return Object.fromEntries(
    jobs.map((job) => [
      `POST ${job.path}`,
      {
        accepts: {
          scheme: "exact",
          price: job.price,
          network: config.network,
          payTo,
          maxTimeoutSeconds: 300,
          extra: PAYMENT_EXTRA,
        },
        resource: new URL(job.path, config.PUBLIC_URL).href,
        description: job.description,
        mimeType: "application/json",
        serviceName: "Anvil",
        tags: [CHALLENGE_TAG, "algorand", "artifacts"],
        extensions: declareDiscoveryExtension({
          bodyType: "json",
          input: job.inputExample as Record<string, unknown>,
          inputSchema: z.toJSONSchema(job.input, { io: "input" }) as Record<string, unknown>,
          output: { example: job.outputExample },
        }),
      },
    ]),
  );
}
