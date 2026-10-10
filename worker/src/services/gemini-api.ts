import { config } from "../config.js";
import { logger } from "../logger.js";
import { draftSchema, parseModelResponse, type ModelDraft } from "../generator/schema.js";
import { AiOutputError } from "./ai-errors.js";
import { setTimeout as delay } from "node:timers/promises";

// Gemini over plain REST (models.generateContent), so the worker needs no extra
// dependency. Same contract as claude-api.ts: returns the parsed drafts.
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

// 5xx ("high demand") is usually a short spike: retry twice. Every attempt,
// failed ones included, counts against the free tier's daily request quota, so
// keep it at that. A 429 is retried only when Google suggests a short wait (a
// per-minute limit); a daily quota says "retry in 12h" and fails at once.
const RETRY_DELAYS_MS = [5_000, 15_000];
const MAX_WAIT_MS = 30_000;
// Per attempt, and for all attempts with their waits together. The total stays under the 10 minute
// generation lease (loops/generator.ts extends it by heartbeat): a retry that cannot finish in the
// budget is not started, and the last attempt gets only what is left.
const ATTEMPT_TIMEOUT_MS = 300_000;
const TOTAL_BUDGET_MS = 540_000;

/** Google's suggested wait (google.rpc.RetryInfo, e.g. "12s"), in ms. */
function suggestedDelayMs(body: any): number | undefined {
  const info = (body?.error?.details ?? []).find((d: any) =>
    String(d?.["@type"] ?? "").endsWith("google.rpc.RetryInfo"),
  );
  const seconds = Number.parseFloat(String(info?.retryDelay ?? ""));
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function retryDelayMs(status: number, body: any, attempt: number): number | undefined {
  if (attempt >= RETRY_DELAYS_MS.length) return undefined;
  const suggested = suggestedDelayMs(body);
  if (status === 429) return suggested !== undefined && suggested <= MAX_WAIT_MS ? suggested : undefined;
  if (status >= 500 && status !== 501) return Math.min(suggested ?? RETRY_DELAYS_MS[attempt], MAX_WAIT_MS);
  return undefined;
}

type GeminiOpts = { fetch?: typeof fetch; signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> };

/** An abort or a timeout, however it reached us (the signal's reason, or a DOMException from the body stream). */
function isAbortOrTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * POST models.generateContent with the retry policy above; returns the parsed body of a 2xx answer
 * and how many HTTP attempts it took (each one counts against the quota, failed ones included).
 */
async function generate(model: string, payload: object, opts: GeminiOpts): Promise<{ body: any; attempts: number }> {
  if (!config.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  const url = `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`;
  const request = JSON.stringify(payload);

  const started = Date.now();
  let res!: Response;
  let body: any;
  let attempts = 0;
  for (let attempt = 0; ; attempt++) {
    const attemptMs = Math.min(ATTEMPT_TIMEOUT_MS, Math.max(1, TOTAL_BUDGET_MS - (Date.now() - started)));
    const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(attemptMs)]) : AbortSignal.timeout(attemptMs);
    attempts++;
    res = await (opts.fetch ?? fetch)(url, {
      method: "POST",
      // Key in a header, never in the URL, so it can't end up in a logged URL.
      headers: { "Content-Type": "application/json", "x-goog-api-key": config.GEMINI_API_KEY },
      body: request,
      signal,
    });
    // A body that is not JSON reads as empty (the status decides). An abort or a timeout while the
    // body is read is not that: rethrow it so the caller classifies it (lease lost, research timeout).
    body = await res.json().catch((err: unknown) => {
      if (signal.aborted || isAbortOrTimeout(err)) throw err;
      return {};
    });
    const delayMs = res.ok ? undefined : retryDelayMs(res.status, body, attempt);
    // A retry needs its wait plus at least a minute to answer.
    if (delayMs === undefined || Date.now() - started + delayMs + 60_000 > TOTAL_BUDGET_MS) break;
    logger.warn("Gemini busy, retrying", { status: res.status, attempt: attempt + 1, delayMs });
    await (opts.sleep ?? ((ms, signal) => delay(ms, undefined, { signal })))(delayMs, opts.signal);
  }
  if (!res.ok) {
    throw new Error(`Gemini API ${res.status}: ${body?.error?.message || res.statusText}`);
  }
  return { body, attempts };
}

/** The first candidate and its answer text; throws on a blocked prompt, a bad stop or no text. */
function readAnswer(body: any): { candidate: any; text: string; stopReason: string } {
  // No candidates only happens when the prompt itself was blocked.
  const blockReason = body.promptFeedback?.blockReason;
  if (blockReason) {
    throw new AiOutputError("AI_REFUSED", `Gemini blocked the prompt: ${blockReason}`);
  }

  const candidate = body.candidates?.[0];
  const stopReason: string = candidate?.finishReason || "unknown";
  if (stopReason !== "STOP") {
    const code = stopReason === "MAX_TOKENS" ? "AI_TRUNCATED" : ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(stopReason) ? "AI_REFUSED" : "AI_BAD_OUTPUT";
    throw new AiOutputError(code, `Gemini stopped with ${stopReason}`);
  }

  const text = (candidate?.content?.parts || [])
    .filter((p: any) => typeof p.text === "string" && !p.thought)
    .map((p: any) => p.text)
    .join("");
  if (!text) {
    throw new AiOutputError("AI_BAD_OUTPUT", "Gemini returned no text");
  }
  return { candidate, text, stopReason };
}

export async function generateDrafts(
  systemPrompt: string,
  userPrompt: string,
  model: string = config.GEMINI_MODEL,
  opts: GeminiOpts = {},
): Promise<{ drafts: ModelDraft[]; stopReason: string }> {
  if (!config.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  logger.info("Calling Gemini API", { model });

  const { body } = await generate(model, {
    // camelCase like every other field here (the API reference name).
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: draftSchema,
      // Thinking tokens count against this on Gemini 3, so leave headroom.
      maxOutputTokens: 32768,
    },
  }, opts);
  const { text, stopReason } = readAnswer(body);

  try {
    return { drafts: parseModelResponse(text), stopReason };
  } catch (err) {
    throw new AiOutputError("AI_BAD_OUTPUT", `Gemini returned an invalid draft batch: ${String(err).slice(0, 300)}`);
  }
}

/** One answer part: its text (a thought part is "") and where grounding says it comes from. */
export interface GeminiSearchResult {
  parts: string[];
  chunks: Array<{ uri: string; title: string }>;
  /** Offsets are UTF-8 bytes inside parts[partIndex]; chunks index into `chunks`. */
  supports: Array<{ partIndex: number; start: number; end: number; text: string; chunks: number[] }>;
  queries: string[];
  /** HTTP attempts it took, retries included. */
  calls: number;
}

/**
 * Google Search grounding for the research step: plain text (no responseSchema) plus
 * groundingMetadata. The search count is webSearchQueries.length; Gemini has no cap parameter,
 * so the caller asks for a maximum in the prompt.
 */
export async function searchWeb(
  systemPrompt: string,
  userPrompt: string,
  model: string = config.GEMINI_MODEL,
  opts: GeminiOpts = {},
): Promise<GeminiSearchResult> {
  if (!config.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }
  logger.info("Calling Gemini API", { model, purpose: "research" });
  const { body, attempts } = await generate(model, {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    tools: [{ google_search: {} }],
    // Thinking tokens count against this on Gemini 3, so leave headroom.
    generationConfig: { maxOutputTokens: 32768 },
  }, opts);
  const { candidate } = readAnswer(body);
  const meta = candidate.groundingMetadata ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    parts: (candidate.content?.parts ?? []).map((p: any) => (typeof p?.text === "string" && !p.thought ? p.text : "")),
    chunks: (meta.groundingChunks ?? []).map((c: any) => ({ uri: String(c?.web?.uri ?? ""), title: String(c?.web?.title ?? "") })),
    supports: (meta.groundingSupports ?? []).map((s: any) => ({
      partIndex: num(s?.segment?.partIndex),
      start: num(s?.segment?.startIndex),
      end: num(s?.segment?.endIndex),
      text: String(s?.segment?.text ?? ""),
      chunks: (Array.isArray(s?.groundingChunkIndices) ? s.groundingChunkIndices : []).filter((i: unknown) => Number.isInteger(i)),
    })),
    queries: (meta.webSearchQueries ?? []).filter((q: unknown) => typeof q === "string"),
    calls: attempts,
  };
}
