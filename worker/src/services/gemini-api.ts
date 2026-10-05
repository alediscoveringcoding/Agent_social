import { config } from "../config.js";
import { logger } from "../logger.js";

// Gemini over plain REST (models.generateContent), so the worker needs no extra
// dependency. Same contract as claude-api.ts: returns the parsed drafts.
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export async function generateDrafts(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ drafts: unknown[]; stopReason: string }> {
  if (!config.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  logger.info("Calling Gemini API", { model: config.GEMINI_MODEL });

  const res = await fetch(
    `${GEMINI_BASE_URL}/models/${encodeURIComponent(config.GEMINI_MODEL)}:generateContent`,
    {
      method: "POST",
      // Key in a header, never in the URL, so it can't end up in a logged URL.
      headers: { "Content-Type": "application/json", "x-goog-api-key": config.GEMINI_API_KEY },
      body: JSON.stringify({
        // camelCase like every other field here (the API reference name).
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          // Thinking tokens count against this on Gemini 3, so leave headroom.
          maxOutputTokens: 32768,
        },
      }),
      signal: AbortSignal.timeout(120_000),
    },
  );

  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Gemini API ${res.status}: ${body?.error?.message || res.statusText}`);
  }

  // No candidates only happens when the prompt itself was blocked.
  const blockReason = body.promptFeedback?.blockReason;
  if (blockReason) {
    throw new Error(`Gemini blocked the prompt: ${blockReason}`);
  }

  const candidate = body.candidates?.[0];
  const stopReason: string = candidate?.finishReason || "unknown";
  if (stopReason !== "STOP") {
    logger.warn("Unexpected finishReason", { stopReason });
  }

  const text = (candidate?.content?.parts || [])
    .filter((p: any) => typeof p.text === "string" && !p.thought)
    .map((p: any) => p.text)
    .join("");
  if (!text) {
    throw new Error(`No text in Gemini response (finishReason ${stopReason})`);
  }

  const parsed = JSON.parse(text);
  return { drafts: parsed.drafts || [parsed], stopReason };
}
