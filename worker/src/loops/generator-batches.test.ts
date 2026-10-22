import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { opening, processGenerationRequest, uniqueRefs, validateDraft } from "./generator.js";
import { AiOutputError } from "../services/ai-errors.js";
import { modelDraft, variant } from "../test-support/drafts.js";

// Amendment 10: a request's length, checked on every text, and long requests written in batches.

const leaseIn = () => new Date(Date.now() + 600000).toISOString();
const okApi = (posted: any[][] = [], failed: string[] = []) => ({
  generationHeartbeat: async () => ({ lease_expires_at: leaseIn() }),
  postDrafts: async (_id: string, drafts: any[]) => { posted.push(drafts); return { created: drafts.length, skipped: 0 }; },
  generationFailed: async (_id: string, code: string) => { failed.push(code); return {}; },
}) as any;
const request = (input: Record<string, unknown>) => ({
  request_id: `r-${Math.random()}`, brand: "taxes-support", lease_expires_at: leaseIn(),
  input: { source: { type: "topic", topic: "Declaratia" }, platforms: ["linkedin"], kinds: ["social"], ...input },
});
const sentence = "Taxes Support explica regulile fiscale pentru veniturile din crypto, cu exemple clare si termene precise. ";
const long = sentence.repeat(14).trim();
const longDraft = (ref: string) => modelDraft({ client_ref: ref, canonical_text: long, variants: [variant("linkedin", long)] });

test("a short text in a long request is a too_short error; a request without a length is not checked", () => {
  const short = modelDraft({ canonical_text: "Prea scurt.", variants: [variant("linkedin", "Prea scurt.")] });
  const checked = validateDraft(short, 0, "taxes-support", { length: "long" });
  assert.deepEqual(checked.validation_errors.filter((e) => e.rule === "too_short").map((e) => e.field), ["canonical_text", "variants.linkedin"]);
  assert.deepEqual(validateDraft(short, 0, "taxes-support", {}).validation_errors.filter((e) => e.rule === "too_short"), []);
  assert.deepEqual(validateDraft(longDraft("1"), 0, "taxes-support", { length: "long" }).validation_errors, []);
});

test("five long drafts take two writer calls; the second is told what the first wrote", async () => {
  const prompts: string[] = [];
  const posted: any[][] = [];
  await processGenerationRequest(request({ count: 5, length: "long" }), {
    api: okApi(posted),
    generate: async (_system, user) => {
      prompts.push(user);
      const n = prompts.length === 1 ? 3 : 2;
      return { drafts: Array.from({ length: n }, (_, i) => longDraft(String(i + 1))), stopReason: "end_turn" };
    },
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /Create exactly 3 drafts/);
  assert.match(prompts[1], /Create exactly 2 drafts/);
  assert.ok(!prompts[0].includes("Already written") && prompts[1].includes("Already written"));
  assert.equal(posted[0].length, 5);
  assert.deepEqual(posted[0].map((d) => d.client_ref), ["1", "2", "3", "b2-1", "b2-2"], "client_ref stays unique in the request");
});

test("short requests keep one call up to eight drafts", async () => {
  let calls = 0;
  await processGenerationRequest(request({ count: 8, length: "short" }), {
    repair: false,
    api: okApi(),
    generate: async () => { calls++; return { drafts: Array.from({ length: 8 }, (_, i) => modelDraft({ client_ref: String(i + 1) })), stopReason: "end_turn" }; },
  });
  assert.equal(calls, 1);
});

test("a too short draft is sent back once and the longer rewrite replaces it", async () => {
  const prompts: string[] = [];
  const posted: any[][] = [];
  await processGenerationRequest(request({ count: 1, length: "long" }), {
    api: okApi(posted),
    generate: async (_system, user) => {
      prompts.push(user);
      return { drafts: [prompts.length === 1 ? modelDraft({ client_ref: "1", canonical_text: "Scurt.", variants: [variant("linkedin", "Scurt.")] }) : longDraft("1")], stopReason: "end_turn" };
    },
  });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /too_short: Long form/);
  assert.deepEqual(posted[0][0].validation_errors, []);
});

test("when a later batch fails, the drafts already written are posted with a note", async () => {
  let calls = 0;
  const posted: any[][] = [];
  const failed: string[] = [];
  await processGenerationRequest(request({ count: 5, length: "long" }), {
    api: okApi(posted, failed),
    generate: async () => {
      calls++;
      if (calls === 2) throw new AiOutputError("AI_TRUNCATED", "cut");
      return { drafts: [longDraft("1"), longDraft("2"), longDraft("3")], stopReason: "end_turn" };
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(failed, []);
  assert.equal(posted[0].length, 3);
  assert.ok(posted[0].every((d) => /Doar 3 din 5 ciorne au fost scrise/.test(d.notes) && /AI_TRUNCATED/.test(d.notes)));
});

test("a failing first batch still fails the request", async () => {
  const failed: string[] = [];
  await processGenerationRequest(request({ count: 5, length: "long" }), {
    api: okApi([], failed),
    generate: async () => { throw new AiOutputError("AI_REFUSED", "no"); },
  });
  assert.deepEqual(failed, ["AI_REFUSED"]);
});

test("helpers: the first sentence, and refs made unique across batches", () => {
  assert.equal(opening("Prima propozitie. A doua."), "Prima propozitie.");
  assert.equal(opening("x".repeat(200)).length, 160);
  const first = uniqueRefs([modelDraft({ client_ref: "1" }), modelDraft({ client_ref: "2" })], [], 0).map((d) => d.client_ref);
  assert.deepEqual(first, ["1", "2"]);
  const taken = [modelDraft({ client_ref: "b2-1" })];
  assert.deepEqual(uniqueRefs([modelDraft({ client_ref: "1" })], taken, 1).map((d) => d.client_ref), ["b2-2-1"]);
});
