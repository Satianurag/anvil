import type { JobDefinition } from "../lib/job.ts";
import { analyze } from "./analyze.ts";
import { attest } from "./attest.ts";
import { audit } from "./audit.ts";
import { browse } from "./browse.ts";
import { certify } from "./certify.ts";
import { evidence } from "./evidence.ts";
import { extract } from "./extract.ts";
import { compare, extractBankStatement, extractInvoice, extractResumeMatch } from "./extract-presets.ts";
import { monitor } from "./monitor.ts";
import { research } from "./research.ts";
import { run } from "./run.ts";
import { test } from "./test.ts";

export const jobs = [
  evidence,
  extract,
  extractInvoice,
  extractBankStatement,
  extractResumeMatch,
  compare,
  run,
  analyze,
  test,
  audit,
  research,
  browse,
  monitor,
  certify,
  attest,
] as JobDefinition[];
