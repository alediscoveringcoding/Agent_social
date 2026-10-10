import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateContent } from "./validators.js";
import { validateDraft } from "../loops/generator.js";
import { buildRepairPrompt, mergeRepairs } from "./repair.js";
import { buildSystemPrompt, buildUserPrompt } from "./prompts.js";
import { detectFigures, unlistedFigures } from "./figures.js";
import { modelDraft, variant } from "../test-support/drafts.js";
import { PLATFORMS } from "../platforms.js";

test("URLs without paths are allowed; standalone brand domains fail", () => {
  for (const text of ["https://taxes.support", "https://thecrypto.support.", "www.taxes.support", "https://taxes.support/2026"]) {
    assert.equal(validateContent(text, "generic").length, 0, text);
  }
  assert.ok(validateContent("Viziteaza taxes.support", "generic").some(e => e.rule === "bare_domain"));
  assert.ok(validateContent("app.thecrypto.support", "generic").some(e => e.rule === "bare_domain"));
});
test("X uses URL, emoji and CJK weights; figures are not validation errors", () => {
  assert.equal(validateContent("a".repeat(256) + " https://example.com/" + "x".repeat(300), "x").length, 0);
  assert.ok(validateContent("a".repeat(257) + " https://example.com/" + "x".repeat(300), "x").some(e => e.rule === "length"));
  assert.equal(validateContent("👨‍👩‍👧‍👦".repeat(140), "x").length, 0);
  assert.ok(validateContent("漢".repeat(141), "x").some(e => e.rule === "length"));
  assert.equal(validateContent("16% pana pe 25 mai 2027, 600 RON", "x").length, 0);
});
test("figure provenance survives detection; URL digits and single digits do not add entries", () => {
  const draft = modelDraft({ canonical_text: "16% pe 25 mai 2027, 600 RON. Pasul 3: https://taxes.support/2026", figures: [
    { value: "16 %", context: "cota", source: "unverified" },
    { value: "16%", context: "cota din articol", source: "article" },
  ] });
  const validated = validateDraft(draft, 0, "taxes-support");
  assert.equal(validated.figures.find(f => f.value === "16%")?.source, "article");
  assert.equal(validated.figures.filter(f => f.value.replace(/\s/g, "") === "16%").length, 1);
  assert.ok(validated.figures.some(f => f.value === "600 RON" && f.source === "unverified"));
  assert.ok(!validated.figures.some(f => f.value === "3" || f.value === "2026"));
  assert.equal(detectFigures("https://taxes.support/2026").length, 0);
  assert.equal(unlistedFigures("2 pasi", []).length, 0);
});
test("article and launch fields fill destination content and canonical URL", () => {
  const article = validateDraft(modelDraft({ kind: "article", article: { title: "Declaratia", subtitle: "", body_markdown: "Un ghid calm", tags: ["taxe"], canonical_url: "" }, variants: [variant("devto", "")] }), 0, "taxes-support", { source: { type: "article", url: "https://taxes.support/blog/ghid" } });
  assert.equal(article.article.canonical_url, "https://taxes.support/blog/ghid");
  assert.equal(article.article.subtitle, null);
  assert.equal(article.validation_errors.length, 0);
  assert.equal(article.card.brand, "taxes-support");
  const launch = validateDraft(modelDraft({ kind: "launch", launch: { name: "Taxes Support", tagline: "Calculezi simplu", description: "Pregatesti declaratia", maker_comment: "" }, variants: [variant("producthunt", "")] }), 0, "taxes-support");
  assert.equal(launch.validation_errors.length, 0);
  assert.equal(launch.launch.maker_comment, null);
  const system = buildSystemPrompt({ slug: "taxes-support", name: "Taxes Support" }, {});
  for (const field of ["body_markdown", "canonical_url", "tagline", "maker_comment"]) assert.ok(system.includes(field));
  assert.ok(buildUserPrompt({ source: { type: "topic", topic: "Lansare" }, platforms: ["producthunt"], count: 1, kinds: ["launch"] }).includes("Kinds: launch"));
});
test("repair only sends failing drafts and preserves valid/missing/worse originals", () => {
  const good = validateDraft(modelDraft({ client_ref: "good" }), 0, "taxes-support");
  const bad = validateDraft(modelDraft({ client_ref: "bad", canonical_text: "ă" }), 1, "taxes-support");
  const fixed = validateDraft(modelDraft({ client_ref: "bad" }), 1, "taxes-support");
  const prompt = buildRepairPrompt([good, bad]);
  assert.ok(!prompt.includes('"client_ref": "good"'));
  assert.deepEqual(mergeRepairs([good, bad], [fixed]), [good, fixed]);
  assert.deepEqual(mergeRepairs([good, bad], []), [good, bad]);
  assert.deepEqual(mergeRepairs([good, bad], [bad, { ...fixed, client_ref: "invented" }]), [good, bad]);
});
test("provider wire overflows remain reviewable instead of losing the draft batch", () => {
  const draft = validateDraft(modelDraft({
    notes: 'n'.repeat(4100),
    article: { title: 'Article', subtitle: 's'.repeat(510), body_markdown: 'Text', tags: [], canonical_url: '' },
    variants: Array.from({ length: PLATFORMS.length + 1 }, () => variant("x", "Text")),
    figures: [{ value: '', context: '', source: 'unverified' }, { value: '16%', context: 'c'.repeat(510), source: 'facts' }],
  }), 0, 'taxes-support');
  assert.equal(draft.notes.length, 4000);
  assert.equal(draft.article.subtitle.length, 500);
  assert.equal(draft.variants.length, PLATFORMS.length);
  assert.equal(draft.figures.length, 1);
  assert.equal(draft.figures[0].context?.length, 500);
  assert.ok(draft.validation_errors.some(e => e.rule === 'wire_limit'));
  const article = { ...draft, article: { ...draft.article, subtitle: null, canonical_url: null } };
  const prompt = buildRepairPrompt([article]);
  assert.ok(!prompt.includes('"subtitle": null'));
  assert.ok(!prompt.includes('"canonical_url": null'));
});
