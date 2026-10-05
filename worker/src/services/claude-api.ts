import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { logger } from "../logger.js";

// Lazy singleton: constructing the SDK client eagerly would throw at import
// time if ANTHROPIC_API_KEY is unset, even when the generator loop never runs.
let client: Anthropic | undefined;
function getClient(): Anthropic {
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  if (!client) {
    client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }
  return client;
}

export async function generateDrafts(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ drafts: unknown[]; stopReason: string }> {
  logger.info("Calling Claude API", { model: config.GENERATOR_MODEL });

  const response = await getClient().messages.create({
    model: config.GENERATOR_MODEL,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });

  // Always check stop_reason before reading content
  const stopReason = response.stop_reason;
  if (stopReason !== "end_turn") {
    logger.warn("Unexpected stop_reason", { stopReason });
  }

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text block in Claude response");
  }

  const parsed = JSON.parse(textBlock.text);
  return { drafts: parsed.drafts || [parsed], stopReason: stopReason || "unknown" };
}
