import { z } from "zod";
import { defineJob } from "../lib/job.ts";
import { sha256 } from "../lib/storage.ts";

export const attest = defineJob({
  path: "/v1/attest",
  price: "$0.10",
  description:
    "Timestamped proof-of-existence: binds a SHA-256 (or content you send) plus a label and metadata to an Algorand transaction. Anyone can later resolve the hash via free GET /v1/verify/hash/{sha256}.",
  input: z
    .object({
      sha256: z
        .string()
        .regex(/^[0-9a-fA-F]{64}$/)
        .optional()
        .describe("Hex SHA-256 of the content to attest"),
      content: z.string().max(1_000_000).optional().describe("UTF-8 content to hash and attest (not stored)"),
      label: z.string().max(200).optional(),
      metadata: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()])).optional(),
    })
    .refine((v) => !!v.sha256 !== (v.content !== undefined), "provide exactly one of sha256 or content")
    .refine((v) => !v.metadata || Object.keys(v.metadata).length <= 20, "at most 20 metadata keys"),
  inputExample: { sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", label: "release v1.0.0" },
  outputExample: {
    sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    label: "release v1.0.0",
    attested_at: "2026-09-27T12:00:00.000Z",
    lookup_path: "/v1/verify/hash/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  },
  async run(input) {
    const hash = (input.sha256 ?? sha256(input.content as string)).toLowerCase();
    const result = {
      sha256: hash,
      label: input.label ?? null,
      metadata: input.metadata ?? {},
      attested_at: new Date().toISOString(),
      lookup_path: `/v1/verify/hash/${hash}`,
    };
    return {
      result,
      index: [hash],
      artifacts: [{ name: "attestation.json", contentType: "application/json", body: JSON.stringify(result, null, 2) }],
    };
  },
});
