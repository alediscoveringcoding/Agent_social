import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { draftSchema, parseModelResponse, type ModelDraft } from "../generator/schema.js";
import { AiOutputError } from "./ai-errors.js";

/** What the callers read from a finished message. `usage` is only needed to count web searches. */
export type ClaudeMessage = Pick<BetaMessage, "stop_reason" | "content" | "model"> & {
  usage?: { server_tool_use?: { web_search_requests?: number } | null } | null;
};
export interface ClaudeClient {
  beta: { messages: {
    stream(params: ClaudeRequest, options?: { signal?: AbortSignal }): {
      finalMessage(): Promise<ClaudeMessage>;
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
  if (stopReason !== "end_turn") throw stopError(stopReason);
  const text = response.content.filter(b => b.type === "text").map(b => b.text).join("");
  try {
    return { drafts: parseModelResponse(text), stopReason };
  } catch (err) {
    throw new AiOutputError("AI_BAD_OUTPUT", `Claude returned an invalid draft batch: ${String(err).slice(0, 300)}`);
  }
}

function stopError(stopReason: string | null | undefined): AiOutputError {
  const code = stopReason === "refusal" ? "AI_REFUSED" : stopReason === "max_tokens" ? "AI_TRUNCATED" : "AI_BAD_OUTPUT";
  return new AiOutputError(code, `Claude stopped with ${stopReason ?? "unknown"}`);
}

// Research (amendment 07): one web-search call, plus at most this many "pause_turn" continuations.
export const MAX_PAUSE_CONTINUATIONS = 3;
const RESEARCH_MAX_TOKENS = 16384;

export interface ClaudeSearchResult {
  /** The content blocks of every turn, in order (one assistant message when the turn was paused). */
  content: ClaudeMessage["content"];
  /** Web searches billed, from usage.server_tool_use.web_search_requests of each call. */
  searches: number;
  /** HTTP calls made: 1 plus one per continuation. */
  calls: number;
  /** The model that answered. */
  model: string;
  /** True when the turn was still paused after the last allowed continuation (or search budget). */
  paused: boolean;
}

/**
 * Web-search call for the research step. No structured output: citations are always on for web
 * search and cannot be combined with output_config.format, so the answer is plain text with
 * citations. A paused turn ("pause_turn") is resumed by sending the assistant content back
 * unchanged, at most MAX_PAUSE_CONTINUATIONS times; each continuation is another call.
 */
export async function searchWeb(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  opts: { maxSearches: number; client?: ClaudeClient; signal?: AbortSignal },
): Promise<ClaudeSearchResult> {
  const anthropic = opts.client ?? getClient();
  const content: ClaudeMessage["content"] = [];
  let searches = 0;
  let calls = 0;
  let answered = model;
  for (;;) {
    // The cap holds across continuations: a resumed call may only use what is left.
    const remaining = opts.maxSearches - searches;
    calls++;
    logger.info("Calling Claude API", { model, purpose: "research", call: calls, maxSearches: remaining });
    const messages: ClaudeRequest["messages"] = [{ role: "user", content: userPrompt }];
    // Paused content goes back as it came, with no extra user message.
    if (content.length) messages.push({ role: "assistant", content: content as unknown as ClaudeRequest["messages"][number]["content"] });
    const response = await anthropic.beta.messages.stream({
      model,
      max_tokens: RESEARCH_MAX_TOKENS,
      system: systemPrompt,
      messages,
      tools: [{
        type: "web_search_20260209",
        name: "web_search",
        max_uses: remaining,
        user_location: { type: "approximate", country: "RO", timezone: "Europe/Bucharest" },
      }],
      ...(config.CLAUDE_SERVER_FALLBACK ? { fallbacks: "default" as const, betas: ["server-side-fallback-2026-07-01" as const] } : {}),
      output_config: { effort: config.GENERATOR_EFFORT },
    }, { signal: opts.signal }).finalMessage();
    if (response.model && response.model !== model) logger.warn("Claude answered with another model", { requested: model, answered: response.model });
    if (response.model) answered = response.model;
    const billed = response.usage?.server_tool_use?.web_search_requests;
    searches += typeof billed === "number" ? billed
      : response.content.filter(b => b.type === "server_tool_use" && b.name === "web_search").length;
    content.push(...response.content);
    if (response.stop_reason === "end_turn") return { content, searches, calls, model: answered, paused: false };
    if (response.stop_reason !== "pause_turn") throw stopError(response.stop_reason);
    if (calls - 1 >= MAX_PAUSE_CONTINUATIONS || searches >= opts.maxSearches) {
      logger.warn("Claude research still paused, using what it found", { calls, searches });
      return { content, searches, calls, model: answered, paused: true };
    }
  }
}
