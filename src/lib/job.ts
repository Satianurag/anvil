import type { z } from "zod";

export interface Artifact {
  name: string;
  contentType: string;
  body: Uint8Array | string;
}

export interface JobOutput {
  /** JSON result returned inline to the caller */
  result: unknown;
  /** Binary/text artifacts stored, hashed and listed in the manifest */
  artifacts?: Artifact[];
  /** Extra SHA-256 hashes (besides artifact hashes) that GET /v1/verify/hash/:sha256 should resolve to this job */
  index?: string[];
}

export interface JobDefinition<S extends z.ZodType = z.ZodType> {
  path: `/v1/${string}`;
  price: `$${string}`;
  description: string;
  input: S;
  /** Example request body for Bazaar discovery */
  inputExample: z.input<S>;
  /** Example output for Bazaar discovery */
  outputExample: Record<string, unknown>;
  run: (input: z.infer<S>, signal: AbortSignal) => Promise<JobOutput>;
  timeoutMs?: number;
}

export const defineJob = <S extends z.ZodType>(job: JobDefinition<S>) => job;

/** Thrown for caller errors; mapped to HTTP 422 so the payment is not settled. */
export class JobInputError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
