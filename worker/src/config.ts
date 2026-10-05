import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const schema = z.object({
  SITE_BASE_URL: z.string().url().default("http://localhost:3000"),
  WORKER_TOKEN: z.string().min(32),
  WORKER_ID: z.string().default("worker-local-01"),

  POSTIZ_BASE_URL: z.string().url().default("http://localhost:4007"),
  POSTIZ_API_KEY: z.string().min(1),

  // Optional: the generator loop is skipped (with a warning) when unset.
  ANTHROPIC_API_KEY: z.string().startsWith("sk-ant-").optional(),
  GENERATOR_MODEL: z.string().default("claude-opus-5-5"),

  WORKER_DRY_RUN: z.coerce.boolean().default(true),
  DELIVERY_LOOP_INTERVAL_MS: z.coerce.number().default(30_000),
  GENERATION_LOOP_INTERVAL_MS: z.coerce.number().default(15_000),
  SYNC_LOOP_INTERVAL_MS: z.coerce.number().default(900_000),
});

export const config = schema.parse(process.env);
