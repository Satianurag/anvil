import type { RouteConfig } from "@x402/core/server";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.ts";
import { jobs } from "../src/routes/index.ts";
import { CHALLENGE_TAG, paidRoutes } from "../src/x402.ts";

type PaymentOption = Exclude<RouteConfig["accepts"], unknown[]>;

const PAY_TO =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".slice(
    0,
    58,
  );

describe("paidRoutes", () => {
  const routes = paidRoutes(jobs, PAY_TO) as Record<string, RouteConfig>;
  const option = (r: RouteConfig) => r.accepts as PaymentOption;

  it("covers every job with one payTo on a full-genesis-hash network id (as GoPlausible advertises)", () => {
    expect(Object.keys(routes).sort()).toEqual(jobs.map((j) => `POST ${j.path}`).sort());
    for (const r of Object.values(routes)) {
      expect(option(r).payTo).toBe(PAY_TO);
      expect(option(r).network).toMatch(/^algorand:[A-Za-z0-9+/]{43}=$/);
      expect(option(r).network).toBe(config.network);
      expect(option(r).extra?.tag).toBe(CHALLENGE_TAG);
    }
  });

  it("declares Bazaar discovery with a valid example input", () => {
    for (const job of jobs) {
      const bazaar = routes[`POST ${job.path}`].extensions?.bazaar as {
        info: { input: { body: unknown } };
        schema: unknown;
      };
      expect(bazaar.info.input.body).toEqual(job.inputExample);
      expect(bazaar.schema).toBeDefined();
      expect(job.input.safeParse(job.inputExample).success).toBe(true);
    }
  });
});
