import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createPaymentWrapper } from "@x402/mcp";
import { z } from "zod";
import { config } from "./config.ts";
import { paymentTxId } from "./lib/chain.ts";
import type { JobDefinition } from "./lib/job.ts";
import { executeJob, precheck } from "./lib/receipts.ts";
import { CHALLENGE_TAG, PAYMENT_EXTRA } from "./x402.ts";

export const toolName = (job: JobDefinition) => job.path.replace(/^\/v1\//, "").replace(/[/-]/g, "_");

type ToolHandler = (
  args: Record<string, unknown>,
  ctx: { meta?: Record<string, unknown> },
) => Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}>;

const handler =
  (job: JobDefinition): ToolHandler =>
  async (args, ctx) => {
    const payment = ctx.meta?.["x402/payment"] as PaymentPayload | undefined;
    try {
      const out = await executeJob(job, args, payment ? paymentTxId(payment) : undefined);
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `${job.path} failed: ${(err as Error).message}` }], isError: true };
    }
  };

type Wrapped = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;

/** One paid MCP tool per job; payments use the same payTo, network and challenge tag as the HTTP routes. */
export async function buildTools(jobs: JobDefinition[], resourceServer?: x402ResourceServer) {
  if (resourceServer && config.PAY_TO) await resourceServer.initialize();
  return Promise.all(
    jobs.map(async (job) => {
      const name = toolName(job);
      let cb: Wrapped = (args) => handler(job)(args, {});
      if (resourceServer && config.PAY_TO) {
        const accepts = await resourceServer.buildPaymentRequirements({
          scheme: "exact",
          network: config.network,
          payTo: config.PAY_TO,
          price: job.price,
          maxTimeoutSeconds: 300,
          extra: PAYMENT_EXTRA,
        });
        const paid = createPaymentWrapper(resourceServer, {
          accepts,
          resource: {
            url: `mcp://tool/${name}`,
            description: job.description,
            mimeType: "application/json",
            serviceName: "Anvil",
            tags: [CHALLENGE_TAG, "algorand", "artifacts"],
          },
          extensions: declareDiscoveryExtension({
            toolName: name,
            description: job.description,
            transport: "streamable-http",
            inputSchema: z.toJSONSchema(job.input, { io: "input" }) as Record<string, unknown>,
            example: job.inputExample as Record<string, unknown>,
            output: { example: job.outputExample },
          }),
        });
        const paidCb = paid((args, ctx) => handler(job)(args, ctx)) as Wrapped;
        cb = async (args, extra) => {
          try {
            await precheck(job, args);
          } catch (err) {
            return {
              content: [{ type: "text", text: `${job.path} invalid input: ${(err as Error).message}` }],
              isError: true,
            };
          }
          return paidCb(args, extra);
        };
      }
      return { job, name, cb };
    }),
  );
}

export function mcpHandler(tools: Awaited<ReturnType<typeof buildTools>>) {
  return async (req: Request) => {
    const server = new McpServer({ name: "anvil", version: "1.0.0" });
    for (const { job, name, cb } of tools)
      server.registerTool(
        name,
        {
          title: `${job.path} (${job.price} USDC)`,
          description: `${job.description} Price: ${job.price} USDC on Algorand via x402.`,
          inputSchema: job.input,
        },
        cb as never,
      );
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  };
}
