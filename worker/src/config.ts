import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

// `KEY=` with nothing after it counts as unset, so blank lines in .env are fine.
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

// Env values are strings. z.coerce.boolean() would turn "false" into true (any
// non-empty string is truthy), so booleans go through z.stringbool():
// true/1/yes/on and false/0/no/off, any case. Anything else is a config error.
const envBool = (fallback: boolean) => z.preprocess(blankToUndefined, z.stringbool().optional()).transform((v) => v ?? fallback);
// Blank must not coerce to 0 (an interval of 0 ms would spin).
const envInt = (fallback: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().positive().optional()).transform((v) => v ?? fallback);

const schema = z.object({
  SITE_BASE_URL: z.string().url().default("http://localhost:3000"),
  WORKER_TOKEN: z.string().min(32),
  WORKER_ID: z.string().default("worker-local-01"),

  POSTIZ_BASE_URL: z.string().url().default("http://localhost:4007"),
  POSTIZ_API_KEY: z.string().min(1),

  // Optional: the generator loop is skipped (with a warning) when no AI key is set.
  // GENERATOR_PROVIDER picks one explicitly; unset means whichever key is present
  // (Claude first). See services/llm.ts.
  GENERATOR_PROVIDER: z.preprocess(blankToUndefined, z.enum(["claude", "gemini"]).optional()),
  ANTHROPIC_API_KEY: z.preprocess(blankToUndefined, z.string().startsWith("sk-ant-").optional()),
  GENERATOR_MODEL: z.preprocess(blankToUndefined, z.string().default("claude-opus-5-5")),
  // PRD F2: effort set explicitly (Claude Opus 5.5 defaults to medium anyway).
  GENERATOR_EFFORT: z.preprocess(blankToUndefined, z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium")),
  GEMINI_API_KEY: z.preprocess(blankToUndefined, z.string().optional()),
  GEMINI_MODEL: z.preprocess(blankToUndefined, z.string().default("gemini-3.8-flash")),

  // Private style pack for the generator (amendment 06). Blank means <repo>/prompts/private.
  STYLE_PACK_DIR: z.preprocess(blankToUndefined, z.string().optional()),
  WORKER_DRY_RUN: envBool(true),
  DELIVERY_LOOP_INTERVAL_MS: envInt(30_000),
  GENERATION_LOOP_INTERVAL_MS: envInt(15_000),
  // Generation leases last 10 minutes; the worker extends its lease this often
  // while it generates and repairs (POST /generation/{id}/heartbeat).
  GENERATION_HEARTBEAT_MS: envInt(120_000),
  SYNC_LOOP_INTERVAL_MS: envInt(900_000),
});

export type WorkerConfig = z.infer<typeof schema>;

/** Parse an environment (process.env by default). Throws a ZodError on bad values. */
export function parseConfig(env: Record<string, string | undefined>): WorkerConfig {
  return schema.parse(env);
}

export const config = parseConfig(process.env);
