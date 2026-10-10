import { config } from "../config.js";
import * as claude from "./claude-api.js";
import * as gemini from "./gemini-api.js";

export type GeneratorProvider = "claude" | "gemini";

/** The AI pick a generation request may carry (input.ai, from the admin form). */
export interface AiChoice {
  provider: GeneratorProvider;
  model: string;
}

/** A request asked for a provider this worker has no key for. */
export class AiNotConfiguredError extends Error {
  readonly code = "AI_NOT_CONFIGURED";
  override name = "AiNotConfiguredError";
}

// GENERATOR_PROVIDER wins when set. Otherwise use whichever key is present,
// Claude first when both are. Used when a request has no AI pick.
export function generatorProvider(): GeneratorProvider | undefined {
  if (config.GENERATOR_PROVIDER) return config.GENERATOR_PROVIDER;
  if (config.ANTHROPIC_API_KEY) return "claude";
  if (config.GEMINI_API_KEY) return "gemini";
  return undefined;
}

export function hasKey(provider: GeneratorProvider): boolean {
  return provider === "claude" ? !!config.ANTHROPIC_API_KEY : !!config.GEMINI_API_KEY;
}

/** Providers this worker can call. The generator loop runs when there is one. */
export function availableProviders(): GeneratorProvider[] {
  return (["claude", "gemini"] as const).filter(hasKey);
}

function defaultModel(provider: GeneratorProvider): string {
  return provider === "gemini" ? config.GEMINI_MODEL : config.GENERATOR_MODEL;
}

const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,63}$/;

/** The request's AI pick (the site only sends listed models), else the worker default. */
export function resolveChoice(ai: unknown): AiChoice {
  if (ai != null) {
    const a = ai as Partial<AiChoice>;
    if ((a.provider !== "claude" && a.provider !== "gemini") || typeof a.model !== "string" || !MODEL_ID.test(a.model)) {
      throw new Error(`Invalid AI choice in the request: ${JSON.stringify(ai).slice(0, 100)}`);
    }
    return { provider: a.provider, model: a.model };
  }
  const provider = generatorProvider();
  if (!provider) throw new AiNotConfiguredError("No ANTHROPIC_API_KEY or GEMINI_API_KEY on the worker");
  return { provider, model: defaultModel(provider) };
}

/** Throws AiNotConfiguredError when the worker has no key for the picked provider. */
export function requireKey(choice: AiChoice): void {
  if (hasKey(choice.provider)) return;
  const key = choice.provider === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
  throw new AiNotConfiguredError(`${key} is not set on the worker, so ${choice.model} can't be used`);
}

export async function generateDrafts(
  systemPrompt: string,
  userPrompt: string,
  choice: AiChoice,
  opts: { signal?: AbortSignal } = {},
): Promise<{ drafts: unknown[]; stopReason: string }> {
  requireKey(choice);
  return choice.provider === "gemini"
    ? gemini.generateDrafts(systemPrompt, userPrompt, choice.model, opts)
    : claude.generateDrafts(systemPrompt, userPrompt, choice.model, opts);
}
