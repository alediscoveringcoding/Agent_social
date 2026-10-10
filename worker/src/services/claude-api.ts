import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { draftSchema, parseModelResponse, type ModelDraft } from "../generator/schema.js";
import { AiOutputError } from "./ai-errors.js";

export interface ClaudeClient {
  beta: { messages: {
    stream(params: ClaudeRequest, options?: { signal?: AbortSignal }): {
      finalMessage(): Promise<Pick<BetaMessage, "stop_reason" | "content" | "model">>;
    };
  } };
}
export type ClaudeRequest = Parameters<Anthropic['beta']['messages']['stream']>[0];
// One generate() is one HTTP call: no SDK retries. The timeout stays under the 10 minute generation
// lease (loops/generator.ts extends it by heartbeat, and aborts when it is lost).
export const CLAUDE_TIMEOUT_MS = 480_000;
let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!config.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  return client ??= new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 0, timeout: CLAUDE_TIMEOUT_MS });
}

export async function generateDrafts(
  systemPrompt: string,
  userPrompt: string,
  model: string = config.GENERATOR_MODEL,
  opts: { client?: ClaudeClient; signal?: AbortSignal } = {},
): Promise<{ drafts: ModelDraft[]; stopReason: string }> {
  logger.info("Calling Claude API", { model });
  const response = await (opts.client ?? getClient()).beta.messages.stream({
    model,
    max_tokens: 32768,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    // Server-side fallback happens inside the same request, so it is still one call.
    ...(config.CLAUDE_SERVER_FALLBACK ? { fallbacks: "default" as const, betas: ["server-side-fallback-2026-07-01" as const] } : {}),
    output_config: {
      effort: config.GENERATOR_EFFORT,
      format: { type: "json_schema", schema: draftSchema },
    },
  }, { signal: opts.signal }).finalMessage();
  if (response.model && response.model !== model) logger.warn("Claude answered with another model", { requested: model, answered: response.model });
  const stopReason = response.stop_reason;
  if (stopReason !== "end_turn") {
    const code = stopReason === "refusal" ? "AI_REFUSED" : stopReason === "max_tokens" ? "AI_TRUNCATED" : "AI_BAD_OUTPUT";
    throw new AiOutputError(code, `Claude stopped with ${stopReason ?? "unknown"}`);
  }
  const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
  try {
    return { drafts: parseModelResponse(text), stopReason };
  } catch (err) {
    throw new AiOutputError("AI_BAD_OUTPUT", `Claude returned an invalid draft batch: ${String(err).slice(0, 300)}`);
  }
}
