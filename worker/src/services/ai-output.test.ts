import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { generateDrafts as claude, type ClaudeClient, type ClaudeRequest } from "./claude-api.js";
import { generateDrafts as gemini } from "./gemini-api.js";
import { draftSchema, parseModelResponse } from "../generator/schema.js";
import { modelDraft } from "../test-support/drafts.js";

const batch = { drafts: [modelDraft()] };
function claudeClient(stop: Anthropic.Message["stop_reason"], text = JSON.stringify(batch), inspect?: (params: ClaudeRequest) => void): ClaudeClient {
  return { beta: { messages: { stream(params) {
    inspect?.(params);
    return { finalMessage: async () => ({ stop_reason: stop, content: [{ type: "text", text, citations: [] }] }) };
  } } } };
}
const response = (finishReason = "STOP", text = JSON.stringify(batch)) => ({ candidates: [{ finishReason, content: { parts: [{ text }] } }] });
const fakeFetch = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as typeof fetch;

test("Claude streams with installed-SDK structured output and effort", async () => {
  const result = await claude("system", "user", "fake-model", { client: claudeClient("end_turn", JSON.stringify(batch), params => {
    assert.equal(params.max_tokens, 32768);
    assert.equal(params.output_config?.effort, "medium");
    assert.equal(params.fallbacks, "default");
    assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01"]);
    assert.deepEqual(params.output_config?.format?.schema, draftSchema);
  }) });
  assert.deepEqual(result.drafts, batch.drafts);
});
test("Claude refuses truncated, refused, unexpected and malformed responses", async () => {
  for (const [stop, code] of [["max_tokens", "AI_TRUNCATED"], ["refusal", "AI_REFUSED"], ["tool_use", "AI_BAD_OUTPUT"]] as const) {
    await assert.rejects(claude("s", "u", "fake", { client: claudeClient(stop) }), { code });
  }
  await assert.rejects(claude("s", "u", "fake", { client: claudeClient("end_turn", '{}') }), { code: "AI_BAD_OUTPUT" });
});
test("Gemini uses same schema with only supported keywords", async () => {
  const allowed = new Set(["$id", "$defs", "$ref", "$anchor", "type", "format", "title", "description", "enum", "items", "prefixItems", "minItems", "maxItems", "minimum", "maximum", "anyOf", "oneOf", "properties", "additionalProperties", "required", "propertyOrdering"]);
  function check(node: any) {
    for (const [key, value] of Object.entries(node)) {
      assert.ok(allowed.has(key), `unsupported keyword ${key}`);
      if (key === "properties") Object.values(value as object).forEach(check);
      else if (["items"].includes(key)) check(value);
      else if (["anyOf", "oneOf", "prefixItems"].includes(key)) (value as unknown[]).forEach(check);
    }
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
    }
  }
  const result = await gemini("s", "u", "fake", { fetch: (async (_url, init) => {
    const body = JSON.parse(init?.body as string);
    assert.equal(body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(body.generationConfig.responseJsonSchema, draftSchema);
    check(body.generationConfig.responseJsonSchema);
    return Response.json(response());
  }) as typeof fetch });
  assert.equal(result.drafts.length, 1);
});
test("Gemini stop reasons and malformed batches fail before drafts are read", async () => {
  for (const [reason, code] of [["MAX_TOKENS", "AI_TRUNCATED"], ["SAFETY", "AI_REFUSED"], ["OTHER", "AI_BAD_OUTPUT"]]) {
    await assert.rejects(gemini("s", "u", "fake", { fetch: fakeFetch(response(reason)) }), { code });
  }
  await assert.rejects(gemini("s", "u", "fake", { fetch: fakeFetch(response("STOP", '{')) }), { code: "AI_BAD_OUTPUT" });
});
test("Gemini retries 5xx twice, a short 429 once, never a daily quota", async () => {
  const waits: number[] = [];
  let attempts = 0;
  await gemini("s", "u", "fake", { fetch: (async () => {
    attempts++;
    return attempts <= 2 ? Response.json({ error: { message: "busy" } }, { status: 503 }) : Response.json(response());
  }) as typeof fetch, sleep: async ms => { waits.push(ms); } });
  assert.deepEqual(waits, [5000, 15000]);
  assert.equal(attempts, 3);
  for (const [retryDelay, expected] of [["12s", 2], ["43200s", 1]] as const) {
    attempts = 0;
    const fetch = (async () => {
      attempts++;
      return attempts > 1 ? Response.json(response()) : Response.json({ error: { details: [{ "@type": "google.rpc.RetryInfo", retryDelay }] } }, { status: 429 });
    }) as typeof globalThis.fetch;
    const promise = gemini("s", "u", "fake", { fetch, sleep: async () => {} });
    if (expected === 1) await assert.rejects(promise); else await promise;
    assert.equal(attempts, expected);
  }
});
test("provider casing normalizes and invented worker-owned properties are refused", () => {
  const draft = modelDraft();
  const upper = { ...draft, kind: "SOCIAL", card: { ...draft.card, template: "LIGHT" }, variants: [{ platform: "X", text: "Text" }] };
  assert.equal(parseModelResponse(JSON.stringify({ drafts: [upper] }))[0].kind, "social");
  assert.throws(() => parseModelResponse(JSON.stringify({ drafts: [{ ...draft, settings: {} }] })));
});
