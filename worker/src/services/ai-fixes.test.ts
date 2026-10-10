import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateDrafts as claude, type ClaudeClient, type ClaudeRequest } from "./claude-api.js";
import { generateDrafts as gemini } from "./gemini-api.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { modelDraft } from "../test-support/drafts.js";

const batch = { drafts: [modelDraft()] };
function client(text = JSON.stringify(batch), answered?: string, inspect?: (p: ClaudeRequest) => void): ClaudeClient {
  return { beta: { messages: { stream(params) {
    inspect?.(params);
    return { finalMessage: async () => ({ model: answered ?? params.model, stop_reason: "end_turn" as const, content: [{ type: "text" as const, text, citations: [] }] }) };
  } } } };
}
const response = (text: string) => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] });

test("Claude warns with both models when another model answered", async () => {
  const warnings: Array<Record<string, unknown> | undefined> = [];
  const original = logger.warn;
  logger.warn = (_msg, data) => { warnings.push(data); };
  try {
    await claude("s", "u", "asked-model", { client: client(undefined, "fallback-model") });
    await claude("s", "u", "same-model", { client: client() });
  } finally { logger.warn = original; }
  assert.deepEqual(warnings, [{ requested: "asked-model", answered: "fallback-model" }]);
});

test("Claude server fallback follows CLAUDE_SERVER_FALLBACK", async () => {
  const seen: ClaudeRequest[] = [];
  const was = config.CLAUDE_SERVER_FALLBACK;
  try {
    config.CLAUDE_SERVER_FALLBACK = false;
    await claude("s", "u", "m", { client: client(undefined, undefined, p => seen.push(p)) });
  } finally { config.CLAUDE_SERVER_FALLBACK = was; }
  assert.equal(seen[0].fallbacks, undefined);
  assert.equal(seen[0].betas, undefined);
});

test("bad output messages carry the parse error", async () => {
  const ok = (err: any) => err.code === "AI_BAD_OUTPUT" && /invalid draft batch: .+/.test(err.message) && err.message.length < 400;
  await assert.rejects(claude("s", "u", "m", { client: client("{") }), ok);
  await assert.rejects(gemini("s", "u", "m", { fetch: (async () => Response.json(response("{"))) as typeof fetch }), ok);
});

test("Gemini attempts get a live signal and retries still follow the delays", async () => {
  const signals: AbortSignal[] = [];
  const waits: number[] = [];
  let attempts = 0;
  await gemini("s", "u", "m", { fetch: (async (_url, init) => {
    signals.push(init!.signal as AbortSignal);
    return ++attempts < 3 ? Response.json({ error: { message: "busy" } }, { status: 503 }) : Response.json(response(JSON.stringify(batch)));
  }) as typeof fetch, sleep: async ms => { waits.push(ms); } });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [5000, 15000]);
  assert.ok(signals.every(s => !s.aborted));
});
