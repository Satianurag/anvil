import type { JobDefinition } from "../lib/job.ts";
import { evidence } from "./evidence.ts";
import { extract } from "./extract.ts";
import { run } from "./run.ts";

export const jobs = [evidence, extract, run] as JobDefinition[];
