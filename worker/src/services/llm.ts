import { config } from "../config.js";
import * as claude from "./claude-api.js";
import * as gemini from "./gemini-api.js";

export type GeneratorProvider = "claude" | "gemini";

// GENERATOR_PROVIDER wins when set. Otherwise use whichever key is present,
// Claude first when both are. Undefined means the generator loop stays off.
export function generatorProvider(): GeneratorProvider | undefined {
  if (config.GENERATOR_PROVIDER) return config.GENERATOR_PROVIDER;
  if (config.ANTHROPIC_API_KEY) return "claude";
  if (config.GEMINI_API_KEY) return "gemini";
  return undefined;
}

export function generateDrafts(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ drafts: unknown[]; stopReason: string }> {
  return generatorProvider() === "gemini"
    ? gemini.generateDrafts(systemPrompt, userPrompt)
    : claude.generateDrafts(systemPrompt, userPrompt);
}
