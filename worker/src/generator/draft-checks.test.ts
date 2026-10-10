import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDraft } from "../loops/generator.js";
import { validateContent } from "./validators.js";
import { isOurBlogUrl } from "./content-rules.js";
import { boundDraftForSite } from "./wire-bounds.js";
import { PLATFORMS } from "../platforms.js";
import { modelDraft, variant } from "../test-support/drafts.js";

const rules = (d: any) => d.validation_errors.map((e: any) => e.rule);
const article = (patch: object = {}) => ({ title: "Titlu", subtitle: "Sub", body_markdown: "Un ghid calm", tags: ["a"], canonical_url: "https://taxes.support/ghid", ...patch });
const check = (patch: any) => validateDraft(modelDraft(patch), 0, "taxes-support");

test("keyword: case-sensitive, and an empty keyword is fine (like the site)", () => {
  const card = modelDraft().card;
  assert.deepEqual(rules(check({ card: { ...card, keyword: "" } })), []);
  assert.deepEqual(rules(check({ card: { ...card, keyword: "Declaratia" } })), ["card_keyword"]);
  assert.deepEqual(rules(check({ card: { ...card, keyword: "declaratia" } })), []);
});

test("empty variant text", () => {
  assert.deepEqual(rules(check({ variants: [variant("x", "  ")] })), ["EMPTY_TEXT"]);
});

test("article platforms need an article title; the canonical must be ours", () => {
  assert.deepEqual(rules(check({ kind: "article", article: null, variants: [variant("devto", "Text")] })), ["TITLE_MISSING", "CANONICAL_MISSING"]);
  assert.deepEqual(rules(check({ kind: "article", article: article({ canonical_url: "" }), variants: [variant("hashnode", "")] })), ["CANONICAL_MISSING"]);
  assert.deepEqual(rules(check({ kind: "article", article: article({ canonical_url: "https://evil.example/x" }), variants: [variant("devto", "")] })), ["CANONICAL_NOT_OURS"]);
  assert.deepEqual(rules(check({ kind: "article", article: article({ canonical_url: "http://taxes.support/x" }), variants: [variant("medium", "")] })), ["CANONICAL_NOT_OURS"]);
  assert.deepEqual(rules(check({ kind: "article", article: article(), variants: [variant("devto", ""), variant("hashnode", "")] })), []);
  assert.ok(isOurBlogUrl("https://www.thecrypto.support/a") && !isOurBlogUrl("https://app.thecrypto.support/a"));
});

test("tag caps: devto 4, hashnode 5", () => {
  const five = ["a", "b", "c", "d", "e"];
  assert.deepEqual(rules(check({ kind: "article", article: article({ tags: five }), variants: [variant("devto", "")] })), ["TOO_MANY_TAGS"]);
  assert.deepEqual(rules(check({ kind: "article", article: article({ tags: five }), variants: [variant("hashnode", "")] })), []);
  assert.deepEqual(rules(check({ kind: "article", article: article({ tags: [...five, "f"] }), variants: [variant("hashnode", "")] })), ["TOO_MANY_TAGS"]);
});

test("producthunt: launch fields, tagline in code points, 260-character text", () => {
  const launch = (patch: object = {}) => ({ name: "Produs", tagline: "Scurt", description: "Descriere", maker_comment: "", ...patch });
  assert.deepEqual(rules(check({ kind: "launch", launch: null, variants: [variant("producthunt", "Text")] })), ["PH_NAME_MISSING", "PH_TAGLINE_MISSING"]);
  assert.deepEqual(rules(check({ kind: "launch", launch: launch({ tagline: "😀".repeat(60) }), variants: [variant("producthunt", "")] })), []);
  assert.deepEqual(rules(check({ kind: "launch", launch: launch({ tagline: "😀".repeat(61) }), variants: [variant("producthunt", "")] })), ["PH_TAGLINE_TOO_LONG"]);
  assert.deepEqual(rules(check({ kind: "launch", launch: launch(), variants: [variant("producthunt", "a".repeat(261))] })), ["length"]);
  assert.deepEqual(rules(check({ kind: "launch", launch: launch(), variants: [variant("producthunt", "")] })), []);
});

test("instagram: www links count as URLs", () => {
  assert.ok(validateContent("vezi www.exemplu.ro", "instagram").some(e => e.rule === "instagram_no_urls"));
  assert.ok(!validateContent("fara link", "instagram").some(e => e.rule === "instagram_no_urls"));
});

test("banned phrases: word start, diacritics folded, whitespace collapsed", () => {
  const banned = (t: string) => validateContent(t, "generic").some(e => e.rule === "banned_phrase");
  assert.ok(banned("Prețul   va crește"));
  assert.ok(banned("Garantată!"));
  assert.ok(banned("TO THE\nMOON"));
  assert.ok(!banned("negarantat"));
});

test("a draft may carry as many variants as there are platforms", () => {
  const variants = PLATFORMS.map(p => variant(p, "Text"));
  const errors: any[] = [];
  assert.equal(boundDraftForSite(modelDraft({ variants }), errors).variants.length, PLATFORMS.length);
  assert.deepEqual(errors, []);
  const over: any[] = [];
  boundDraftForSite(modelDraft({ variants: [...variants, variant("x", "Text")] }), over);
  assert.deepEqual(over.map(e => e.rule), ["wire_limit"]);
});
