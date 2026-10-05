import { config } from "../config.js";
import { logger } from "../logger.js";

// Gemini over plain REST (models.generateContent), so the worker needs no extra
// dependency. Same contract as claude-api.ts: returns the parsed drafts.
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// 5xx ("high demand") is usually a short spike: retry twice. Every attempt,
// failed ones included, counts against the free tier's daily request quota, so
// keep it at that. A 429 is retried only when Google suggests a short wait (a
// per-minute limit); a daily quota says "retry in 12h" and fails at once.
const RETRY_DELAYS_MS = [5_000, 15_000];
const MAX_WAIT_MS = 30_000;

/** Google's suggested wait (google.rpc.RetryInfo, e.g. "12s"), in ms. */
function suggestedDelayMs(body: any): number | undefined {
  const info = (body?.error?.details ?? []).find((d: any) =>
    String(d?.["@type"] ?? "").endsWith("google.rpc.RetryInfo"),
  );
  const seconds = Number.parseFloat(String(info?.retryDelay ?? ""));
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function retryDelayMs(status: number, body: any, attempt: number): number | undefined {
  if (attempt >= RETRY_DELAYS_MS.length) return undefined;
  const suggested = suggestedDelayMs(body);
  if (status === 429) return suggested !== undefined && suggested <= MAX_WAIT_MS ? suggested : undefined;
  if (status >= 500 && status !== 501) return Math.min(suggested ?? RETRY_DELAYS_MS[attempt], MAX_WAIT_MS);
  return undefined;
}

export async function generateDrafts(
  systemPrompt: string,
  userPrompt: string,
): Promise<{ drafts: unknown[]; stopReason: string }> {
  if (!config.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  logger.info("Calling Gemini API", { model: config.GEMINI_MODEL });

  const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(config.GEMINI_MODEL)}:generateContent`;
  const request = JSON.stringify({
    // camelCase like every other field here (the API reference name).
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      // Thinking tokens count against this on Gemini 3, so leave headroom.
      maxOutputTokens: 32768,
    },
  });

  let res!: Response;
  let body: any;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, {
      method: "POST",
      // Key in a header, never in the URL, so it can't end up in a logged URL.
      headers: { "Content-Type": "application/json", "x-goog-api-key": config.GEMINI_API_KEY },
      body: request,
      signal: AbortSignal.timeout(120_000),
    });
    body = await res.json().catch(() => ({}));
    const delayMs = res.ok ? undefined : retryDelayMs(res.status, body, attempt);
    if (delayMs === undefined) break;
    logger.warn("Gemini busy, retrying", { status: res.status, attempt: attempt + 1, delayMs });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
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
