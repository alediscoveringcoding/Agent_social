import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { processGenerationRequest, validateDraft } from "./generator.js";
import { LeaseLostError } from "../services/site-api.js";
import { AiOutputError } from "../services/ai-errors.js";
import { modelDraft } from "../test-support/drafts.js";
import { buildRepairPrompt } from "../generator/repair.js";
import { buildUserPrompt } from "../generator/prompts.js";
import { boundDraftForSite, SOURCE_LIMITS } from "../generator/wire-bounds.js";
import { ModelDraftSchema, draftSchema, parseModelResponse } from "../generator/schema.js";
import type { ResearchBrief } from "../generator/research-types.js";
import type { ResearchRunner } from "../generator/research.js";

const brief: ResearchBrief = {
  text: "Dobanda a crescut la 6%.[S1] Ministerul a confirmat.[S2]",
  sources: [
    { id: "S1", url: "https://www.bnr.ro/comunicat", title: "Comunicat BNR", publisher: "bnr.ro", published_at: "April 3, 2026", cited_text: "dobanda" },
    { id: "S2", url: "https://example.org/b", title: "Ministerul", publisher: "", published_at: "", cited_text: "" },
  ],
  searches: 2, provider: "claude", model: "claude-opus-5-5",
};
const base = { platforms: ["x"], kinds: ["social"], count: 1 };
const researchInput = { ...base, source: { type: "topic", topic: "Dobanda", hooks: [] }, research: true };
const plainInput = { ...base, source: { type: "topic", topic: "Dobanda", hooks: [] } };
const newsInput = { ...base, source: { type: "news", topic: "", window_days: 7 } };
const cited = (patch: Record<string, unknown> = {}) => modelDraft({
  canonical_text: "Dobanda a crescut la 6%.",
  figures: [{ value: "6%", context: "dobanda", source: "unverified", source_id: "S1" }],
  sources: [{ id: "S1", note: "cifra din comunicat" }],
  ...patch,
} as never);
const figureOf = (d: { figures: unknown[] }, value: string): any => d.figures.find((f) => (f as { value: string }).value === value);
const ruleOf = (d: { validation_errors: Array<{ rule: string }> }) => d.validation_errors.map((e) => e.rule);

// --- id to URL mapping ---

test("source ids become the URLs the search found; a figure keeps its web source and stays unverified", () => {
  const draft = validateDraft(cited({
    sources: [{ id: "S1", note: "cifra din comunicat" }, { id: " [s2] ", note: "" }],
    figures: [{ value: "6%", context: "dobanda", source: "facts", source_id: "S1" }],
  }), 0, "taxes-support", researchInput, brief);
  assert.deepEqual(draft.validation_errors, []);
  assert.deepEqual(draft.sources, [
    { url: "https://www.bnr.ro/comunicat", title: "Comunicat BNR", publisher: "bnr.ro", published_at: "April 3, 2026", note: "cifra din comunicat", found_in_search: true },
    { url: "https://example.org/b", title: "Ministerul", found_in_search: true },
  ]);
  const figure = figureOf(draft, "6%");
  assert.equal(figure.source, "unverified");
  assert.equal(figure.source_url, "https://www.bnr.ro/comunicat");
  assert.ok(!("source_id" in figure));
});

test("an unknown id is dropped with source_unknown; a draft left with no source gets sources_missing", () => {
  const some = validateDraft(cited({ sources: [{ id: "S9", note: "" }, { id: "S1", note: "" }] }), 0, "taxes-support", researchInput, brief);
  assert.deepEqual(ruleOf(some).filter((r) => r.startsWith("source")), ["source_unknown"]);
  assert.deepEqual(some.sources.map((s: { url: string }) => s.url), ["https://www.bnr.ro/comunicat"]);

  const none = validateDraft(cited({ sources: [{ id: "S9", note: "" }], figures: [] }), 0, "taxes-support", researchInput, brief);
  assert.deepEqual(none.sources, []);
  assert.deepEqual(ruleOf(none).filter((r) => r.startsWith("source")), ["source_unknown", "sources_missing"]);

  const empty = validateDraft(cited({ sources: [], figures: [] }), 0, "taxes-support", researchInput, brief);
  assert.deepEqual(ruleOf(empty).filter((r) => r.startsWith("source")), ["sources_missing"]);

  const figure = validateDraft(cited({ figures: [{ value: "6%", context: "", source: "unverified", source_id: "S7" }] }), 0, "taxes-support", researchInput, brief);
  const unknown = figure.validation_errors.find((e) => e.rule === "source_unknown");
  assert.equal(unknown?.field, "figures.source_id");
  assert.equal(figureOf(figure, "6%").source_url, undefined);
});

test("a source only a figure cites is added to the draft's list; repeated ids are listed once", () => {
  const draft = validateDraft(cited({
    sources: [{ id: "S1", note: "a" }, { id: "s1", note: "b" }],
    figures: [{ value: "6%", context: "", source: "unverified", source_id: "S2" }],
  }), 0, "taxes-support", researchInput, brief);
  assert.deepEqual(draft.sources.map((s: { url: string }) => s.url), ["https://www.bnr.ro/comunicat", "https://example.org/b"]);
  assert.equal(draft.sources[0].note, "a");
  assert.ok(!ruleOf(draft).includes("sources_missing"));
});

test("a request without research: sources are [] and any source_id is ignored", () => {
  const draft = validateDraft(cited(), 0, "taxes-support", plainInput);
  assert.deepEqual(draft.sources, []);
  assert.deepEqual(draft.validation_errors, []);
  const figure = figureOf(draft, "6%");
  assert.equal(figure.source, "unverified");
  assert.ok(!("source_id" in figure) && !("source_url" in figure));
  // Same for an old caller that has no sources field at all.
  const { sources: _gone, ...legacy } = modelDraft();
  assert.deepEqual(validateDraft(legacy, 0, "taxes-support").sources, []);
});

test("a news source researches even without the flag", () => {
  const draft = validateDraft(cited({ sources: [], figures: [] }), 0, "taxes-support", newsInput, brief);
  assert.ok(ruleOf(draft).includes("sources_missing"));
});

// --- wire bounds ---

test("wire bounds: 20 sources; title 300, publisher 200, published_at 40, note 500; a cut URL is never sent", () => {
  assert.deepEqual({ ...SOURCE_LIMITS }, { count: 20, url: 2048, title: 300, publisher: 200, published_at: 40, note: 500 });
  const source = (i: number, patch: Record<string, unknown> = {}) => ({ url: `https://example.org/${i}`, title: "t", found_in_search: true, ...patch });
  const errors: Array<{ rule: string; field?: string }> = [];
  const bounded = boundDraftForSite({
    ...modelDraft(),
    sources: [
      ...Array.from({ length: 22 }, (_, i) => source(i)),
    ],
  }, errors as never);
  assert.equal(bounded.sources.length, 20);
  assert.deepEqual(errors.filter((e) => e.field === "sources").length, 1);

  const long: Array<{ rule: string; field?: string }> = [];
  const draft = boundDraftForSite({
    ...modelDraft(),
    figures: [{ value: "6%", context: "", source: "unverified", source_url: `https://example.org/${"x".repeat(2100)}` }],
    sources: [
      source(1, { title: "t".repeat(301), publisher: "p".repeat(201), published_at: "d".repeat(41), note: "n".repeat(501) }),
      source(2, { url: `https://example.org/${"y".repeat(2100)}` }),
      source(3, { url: "  " }),
      source(4, { url: `https://example.org/${"z".repeat(2020)}` }),
    ],
  }, long as never);
  assert.deepEqual(draft.sources.map((s: { url: string }) => s.url.slice(0, 21)), ["https://example.org/1", "https://example.org/z"]);
  assert.equal(draft.sources[0].title.length, 300);
  assert.equal(draft.sources[0].publisher.length, 200);
  assert.equal(draft.sources[0].published_at.length, 40);
  assert.equal(draft.sources[0].note.length, 500);
  assert.equal(draft.sources[1].url.length, 2020 + "https://example.org/".length);
  assert.equal("source_url" in draft.figures[0], false);
  for (const field of ["sources.url", "sources.title", "sources.publisher", "sources.published_at", "sources.note", "figures.source_url"]) {
    assert.ok(long.some((e) => e.rule === "wire_limit" && e.field === field), field);
  }
});

// --- model schema and repair prompt ---

test("ModelDraftSchema requires sources and figures[].source_id; a missing field reads as empty", () => {
  assert.equal(ModelDraftSchema.safeParse(modelDraft()).success, true);
  const { sources: _s, ...noSources } = modelDraft();
  assert.equal(ModelDraftSchema.safeParse(noSources).success, false);
  assert.equal(ModelDraftSchema.safeParse(modelDraft({ figures: [{ value: "6%", context: "", source: "unverified" } as never] })).success, false);
  const schema = draftSchema as any;
  const draftProps = schema.properties.drafts.items;
  assert.ok(draftProps.required.includes("sources"));
  assert.deepEqual(draftProps.properties.sources.items.required.sort(), ["id", "note"]);
  assert.ok(draftProps.properties.figures.items.required.includes("source_id"));
  // A response from before the fields existed still parses, as "no sources".
  const old = JSON.parse(JSON.stringify({ drafts: [{ ...modelDraft(), figures: [{ value: "6%", context: "", source: "unverified" }] }] }));
  delete old.drafts[0].sources;
  const parsed = parseModelResponse(JSON.stringify(old));
  assert.deepEqual(parsed[0]!.sources, []);
  assert.equal(parsed[0]!.figures[0]!.source_id, "");
});

test("the repair prompt lists the brief's sources and shows the draft with ids, not URLs", () => {
  const draft = validateDraft(cited({ canonical_text: "Dobanda a crescut la 6%. ă" }), 0, "taxes-support", researchInput, brief);
  assert.ok(draft.validation_errors.length > 0);
  const prompt = buildRepairPrompt([draft], brief);
  assert.ok(prompt.includes("S1: Comunicat BNR | bnr.ro | April 3, 2026 | https://www.bnr.ro/comunicat"));
  assert.ok(prompt.includes("S2: Ministerul |  |  | https://example.org/b"));
  const originals = JSON.parse(prompt.slice(prompt.indexOf("Original drafts:\n") + "Original drafts:\n".length, prompt.indexOf("\n\nSOURCES")));
  assert.deepEqual(originals[0].sources, [{ id: "S1", note: "cifra din comunicat" }]);
  assert.equal(originals[0].figures.find((f: { value: string }) => f.value === "6%").source_id, "S1");
  assert.equal(originals[0].figures.some((f: object) => "source_url" in f), false);
  assert.ok(!JSON.stringify(originals).includes("found_in_search"));

  const plain = validateDraft(cited({ canonical_text: "ă" }), 0, "taxes-support", plainInput);
  const plainPrompt = buildRepairPrompt([plain]);
  assert.ok(!plainPrompt.includes("SOURCES"));
  assert.ok(plainPrompt.includes('"sources": []'));
  assert.ok(plainPrompt.includes('"source_id": ""'));
});

// --- the loop ---

const leaseIn = () => new Date(Date.now() + 600000).toISOString();
function harness() {
  const posted: any[] = [];
  const failed: Array<[string, string]> = [];
  const api = {
    generationHeartbeat: async () => ({ lease_expires_at: leaseIn() }),
    postDrafts: async (_id: string, drafts: any[]) => { posted.push(...drafts); return { created: drafts.length, skipped: 0 }; },
    generationFailed: async (_id: string, code: string, message: string) => { failed.push([code, message]); return {}; },
  } as any;
  return { api, posted, failed };
}
const request = (input: unknown, id = "req") => ({ request_id: id, brand: "taxes-support", input, lease_expires_at: leaseIn() });
const found: ResearchRunner = async () => ({ ...brief, calls: 2 });

test("research request: research, then the writer with the brief, then a repair that carries the sources", async () => {
  const { api, posted, failed } = harness();
  const events: string[] = [];
  let researchOpts: Parameters<ResearchRunner>[3];
  await processGenerationRequest(request(researchInput), {
    api,
    research: async (system, user, choice, opts) => {
      events.push("research");
      researchOpts = opts;
      assert.ok(system.length > 0 && user.length > 0);
      assert.equal(choice.provider, "claude");
      return found(system, user, choice, opts);
    },
    generate: async (_system, user, _choice, opts) => {
      if (!events.includes("write")) {
        events.push("write");
        assert.equal(user, buildUserPrompt(researchInput, brief));
        assert.ok(user.includes(brief.text) && user.includes("https://www.bnr.ro/comunicat"));
        // One unknown id: the batch needs the repair call.
        return { drafts: [cited({ sources: [{ id: "S9", note: "" }, { id: "S1", note: "cifra" }] })], stopReason: "end_turn" };
      }
      events.push("repair");
      assert.ok(user.includes("S1: Comunicat BNR | bnr.ro | April 3, 2026 | https://www.bnr.ro/comunicat"));
      assert.ok(user.includes("source_unknown"));
      assert.ok(opts?.signal instanceof AbortSignal);
      return { drafts: [cited({ sources: [{ id: "S1", note: "cifra" }] })], stopReason: "end_turn" };
    },
  });
  assert.deepEqual(events, ["research", "write", "repair"]);
  assert.deepEqual(failed, []);
  assert.equal(researchOpts?.maxSearches, 5);
  assert.ok(researchOpts?.signal instanceof AbortSignal);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].validation_errors, []);
  assert.deepEqual(posted[0].sources, [{ url: "https://www.bnr.ro/comunicat", title: "Comunicat BNR", publisher: "bnr.ro", published_at: "April 3, 2026", note: "cifra", found_in_search: true }]);
});

test("a brief with no sources fails with RESEARCH_EMPTY and makes no writer call", async () => {
  const { api, posted, failed } = harness();
  let writes = 0;
  await processGenerationRequest(request(researchInput), {
    api,
    research: async () => ({ ...brief, sources: [], searches: 3, calls: 1 }),
    generate: async () => { writes++; return { drafts: [modelDraft()], stopReason: "end_turn" }; },
  });
  assert.equal(writes, 0);
  assert.deepEqual(posted, []);
  assert.equal(failed.length, 1);
  assert.equal(failed[0]![0], "RESEARCH_EMPTY");
  assert.match(failed[0]![1], /3 searches/);
});

test("a brief where no story passed the audit fails with RESEARCH_NO_STORY and makes no writer call", async () => {
  const { api, posted, failed } = harness();
  let writes = 0;
  await processGenerationRequest(request(researchInput), {
    api,
    research: async () => ({ ...brief, text: "NO QUALIFYING STORY\nBNR rate decision | 7 | no fixed date", calls: 1 }),
    generate: async () => { writes++; return { drafts: [modelDraft()], stopReason: "end_turn" }; },
  });
  assert.equal(writes, 0);
  assert.deepEqual(posted, []);
  assert.equal(failed[0]![0], "RESEARCH_NO_STORY");
  assert.match(failed[0]![1], /BNR rate decision/);
});

test("a research failure reports its code and makes no writer call", async () => {
  for (const [error, code] of [[new AiOutputError("AI_REFUSED", "Claude stopped with refusal"), "AI_REFUSED"], [new Error("Research timed out after 300000 ms"), "GENERATION_ERROR"]] as const) {
    const { api, failed } = harness();
    let writes = 0;
    await processGenerationRequest(request(researchInput), {
      api,
      research: async () => { throw error; },
      generate: async () => { writes++; return { drafts: [modelDraft()], stopReason: "end_turn" }; },
    });
    assert.equal(writes, 0);
    assert.deepEqual(failed.map((f) => f[0]), [code]);
  }
});

test("a request without research makes exactly one AI call, as before", async () => {
  const { api, posted, failed } = harness();
  let writes = 0;
  await processGenerationRequest(request(plainInput), {
    api,
    research: async () => { throw new Error("research must not run"); },
    generate: async (_system, user) => {
      writes++;
      assert.equal(user, buildUserPrompt(plainInput));
      return { drafts: [cited()], stopReason: "end_turn" };
    },
  });
  assert.equal(writes, 1);
  assert.deepEqual(failed, []);
  assert.deepEqual(posted[0].sources, []);
  assert.deepEqual(posted[0].validation_errors, []);
});

test("a news source researches without the flag; a repair-off batch posts sources_missing for review", async () => {
  const { api, posted, failed } = harness();
  let researches = 0;
  let writes = 0;
  await processGenerationRequest(request(newsInput), {
    api, repair: false,
    research: async (...args) => { researches++; return found(...args); },
    generate: async (_system, user) => {
      writes++;
      assert.equal(user, buildUserPrompt(newsInput, brief));
      return { drafts: [cited({ sources: [], figures: [] })], stopReason: "end_turn" };
    },
  });
  assert.equal(researches, 1);
  assert.equal(writes, 1);
  assert.deepEqual(failed, []);
  assert.deepEqual(ruleOf(posted[0]), ["sources_missing"]);
});

test("the research call runs under the lease: a lost lease stops it with no report", async () => {
  let reported = 0;
  let writes = 0;
  let aborted = false;
  await processGenerationRequest(request(researchInput), {
    heartbeatMs: 10,
    api: {
      generationHeartbeat: async () => { throw new LeaseLostError(); },
      postDrafts: async () => { reported++; return {}; },
      generationFailed: async () => { reported++; return {}; },
    } as any,
    research: async (_s, _u, _c, opts) => {
      try { await delay(5000, undefined, { signal: opts?.signal }); }
      catch (err) { aborted = opts!.signal!.aborted; throw err; }
      return { ...brief, calls: 1 };
    },
    generate: async () => { writes++; return { drafts: [modelDraft()], stopReason: "end_turn" }; },
  });
  assert.equal(aborted, true);
  assert.equal(writes, 0);
  assert.equal(reported, 0);
});
