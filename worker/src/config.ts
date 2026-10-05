import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

// `KEY=` with nothing after it counts as unset, so blank lines in .env are fine.
const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);

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
  GENERATOR_MODEL: z.string().default("claude-opus-5-5"),
  GEMINI_API_KEY: z.preprocess(blankToUndefined, z.string().optional()),
  GEMINI_MODEL: z.string().default("gemini-3.8-flash"),

  WORKER_DRY_RUN: z.coerce.boolean().default(true),
  DELIVERY_LOOP_INTERVAL_MS: z.coerce.number().default(30_000),
  GENERATION_LOOP_INTERVAL_MS: z.coerce.number().default(15_000),
  SYNC_LOOP_INTERVAL_MS: z.coerce.number().default(900_000),
});

export const config = schema.parse(process.env);
