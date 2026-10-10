import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as yaml from "yaml";
import { allowedLinkKeys, factFigures, isAllowedLink, linkKey, loadFacts, mapDraftSources } from "./source-map.js";
import { validateLinksFromSearch } from "./validators.js";
import { normalizeFigure } from "./figures.js";
import type { ResearchBrief } from "./research-types.js";
import { modelDraft, variant } from "../test-support/drafts.js";

const brief: ResearchBrief = {
  text: "Dobanda a crescut la 6%.[S1] Ministerul a confirmat.[S2]",
  sources: [
    { id: "S1", url: "https://www.bnr.ro/comunicat", title: "Comunicat BNR", publisher: "bnr.ro", published_at: "", cited_text: "" },
    { id: "S2", url: "https://example.org/b", title: "Ministerul", publisher: "", published_at: "", cited_text: "" },
  ],
  searches: 2, provider: "claude", model: "claude-opus-5-5",
};
const ARTICLE = "https://taxes.support/blog/ghid";
const FACTS_YAML = `
tax_rates:
  - fact: "Impozitul pe castigurile din criptomonede este 10%"
    valid_from: "2024-01-01"
    source: "Codul Fiscal, art. 94"
deadlines:
  - fact: "Declaratia Unica se depune pana pe 25 mai"
    recurrence: "annual"
`;
const facts = factFigures(yaml.parse(FACTS_YAML));

// --- links ---

test("linkKey: the same page whatever the scheme, www, slash or fragment; not a URL gives null", () => {
  const key = linkKey("https://www.bnr.ro/comunicat");
  assert.equal(key, "bnr.ro/comunicat");
  for (const same of ["http://bnr.ro/comunicat/", "HTTPS://WWW.BNR.RO/comunicat#sectiune", " www.bnr.ro/comunicat "]) assert.equal(linkKey(same), key, same);
  assert.notEqual(linkKey("https://bnr.ro/alt-comunicat"), key);
  assert.notEqual(linkKey("https://bnr.ro/comunicat?id=2"), key);
  for (const bad of ["", "   ", "javascript:alert(1)", "ftp://bnr.ro/x", "nu e un link", null, undefined, 3]) assert.equal(linkKey(bad), null, String(bad));
});

test("allowedLinkKeys: the brief's sources plus the request's article", () => {
  const allowed = allowedLinkKeys(brief, ARTICLE);
  assert.deepEqual([...allowed].sort(), ["bnr.ro/comunicat", "example.org/b", "taxes.support/blog/ghid"]);
  assert.deepEqual([...allowedLinkKeys(undefined)], []);
  assert.equal(isAllowedLink("http://example.org/b/", allowed), true);
  assert.equal(isAllowedLink("https://example.org/c", allowed), false);
  assert.equal(isAllowedLink("", allowed), false);
});

test("research request: a source_url or link the search did not return is replaced, with a note and no error", () => {
  const { draft, errors } = mapDraftSources(modelDraft({
    source_url: "https://invented.example/a",
    notes: "Verifica cifra.",
    sources: [{ id: "S2", note: "" }, { id: "S1", note: "" }],
    variants: [
      variant("x", "Text.", { link: "https://invented.example/b" }),
      variant("pinterest", "Text.", { link: "https://www.bnr.ro/comunicat/" }),
      variant("lemmy", "Text.", { link: ARTICLE }),
      variant("tumblr", "Text.", { link: "" }),
    ],
  }), brief, true, { articleUrl: ARTICLE, facts });
  assert.deepEqual(errors, []);
  // The first cited source (S2 was cited first).
  assert.equal(draft.source_url, "https://example.org/b");
  assert.deepEqual(draft.variants.map((v: { link: string }) => v.link), ["", "https://www.bnr.ro/comunicat/", ARTICLE, ""]);
  assert.match(draft.notes, /^Verifica cifra\.\n/);
  assert.match(draft.notes, /invented\.example\/a .*inlocuit cu https:\/\/example\.org\/b/);
  assert.match(draft.notes, /invented\.example\/b pentru x .*scos/);
  assert.equal(draft.notes.split("\n").length, 3);
});

test("research request: with no cited source the invented source_url becomes empty; the request's article is kept", () => {
  const none = mapDraftSources(modelDraft({ source_url: "https://invented.example/a", sources: [] }), brief, true);
  assert.equal(none.draft.source_url, "");
  assert.deepEqual(none.errors.map((e) => e.rule), ["sources_missing"]);
  assert.match(none.draft.notes, /scos/);

  const article = mapDraftSources(modelDraft({ source_url: ARTICLE, sources: [{ id: "S1", note: "" }] }), brief, true, { articleUrl: ARTICLE });
  assert.equal(article.draft.source_url, ARTICLE);
  assert.equal(article.draft.notes, "");
  // Without the article option the same URL is not trusted.
  assert.equal(mapDraftSources(modelDraft({ source_url: ARTICLE, sources: [{ id: "S1", note: "" }] }), brief, true).draft.source_url, "https://www.bnr.ro/comunicat");
  // An empty source_url is left alone.
  assert.equal(mapDraftSources(modelDraft({ source_url: "", sources: [{ id: "S1", note: "" }] }), brief, true).draft.source_url, "");
});

test("not a research request: links are not touched", () => {
  const { draft } = mapDraftSources(modelDraft({ source_url: "https://anything.example/a", variants: [variant("pinterest", "T", { link: "https://anything.example/b" })] }), undefined, false);
  assert.equal(draft.source_url, "https://anything.example/a");
  assert.equal(draft.variants[0].link, "https://anything.example/b");
  assert.equal(draft.notes, "");
});

// --- figures ---

test("verified facts: only the fact texts count, normalized", () => {
  assert.ok(facts.includes(normalizeFigure("10%")));
  assert.ok(facts.includes(normalizeFigure("25 mai")));
  // The validity date and the legal article are not figures the model may claim.
  assert.ok(!facts.includes("2024-01-01"));
  assert.ok(!facts.includes("94"));
  assert.deepEqual(factFigures(null), []);
  assert.deepEqual(factFigures({}), []);
});

test("research request: a figure keeps 'facts' only when the verified facts state it; the rest is unverified", () => {
  const figure = (value: string, source: string, source_id = "") => ({ value, context: "", source, source_id });
  const { draft, errors } = mapDraftSources(modelDraft({
    sources: [{ id: "S1", note: "" }],
    figures: [
      figure("10%", "facts"), // in the facts
      figure("10,0 %", "facts"), // same figure, written differently
      figure("25 mai", "facts"),
      figure("10", "facts"), // a bare number the facts state
      figure("7%", "facts"), // claims facts, is not in them
      figure("1.000 lei", "article"), // the web via the article label
      figure("10%", "article"), // only "facts" is trusted, and only with the value in the facts
      figure("3%", "unverified"),
      figure("6%", "facts", "S1"), // web source: unverified with its link
      figure("10%", "facts", "S9"), // unknown id: an error, and the facts check still decides
    ] as never,
  }), brief, true, { facts });
  const by = (n: number) => draft.figures[n];
  assert.deepEqual(draft.figures.map((f: { source: string }) => f.source), [
    "facts", "facts", "facts", "facts", "unverified", "unverified", "unverified", "unverified", "unverified", "facts",
  ]);
  assert.equal(by(8).source_url, "https://www.bnr.ro/comunicat");
  assert.ok(draft.figures.every((f: object) => !("source_id" in f)));
  assert.deepEqual(errors.map((e) => e.rule), ["source_unknown"]);
});

test("without any facts nothing counts as verified on a research request; a plain request keeps the model's source", () => {
  const input = modelDraft({ sources: [{ id: "S1", note: "" }], figures: [{ value: "10%", context: "", source: "facts", source_id: "" }] });
  assert.equal(mapDraftSources(input, brief, true, { facts: [] }).draft.figures[0].source, "unverified");
  assert.equal(mapDraftSources(input, brief, true).draft.figures[0].source, "unverified");
  assert.equal(mapDraftSources(input, undefined, false).draft.figures[0].source, "facts");
});

test("loadFacts reads prompts/facts.yaml: its fact texts give figures", () => {
  const real = loadFacts();
  assert.ok(real && typeof real === "object");
  assert.ok(factFigures(real).length > 0);
});

// --- the text validator ---

test("link_not_from_search: a link in the text must be a source of the brief or the request's article, www. ones included", () => {
  const allowed = allowedLinkKeys(brief, ARTICLE);
  assert.deepEqual(validateLinksFromSearch("Detalii: https://www.bnr.ro/comunicat.", allowed), []);
  assert.deepEqual(validateLinksFromSearch(`Citeste ${ARTICLE} si http://example.org/b/`, allowed), []);
  assert.deepEqual(validateLinksFromSearch("Fara link, doar text cu 6%.", allowed), []);
  const bad = validateLinksFromSearch("Vezi https://invented.example/x si www.also-invented.ro/y, dar si https://invented.example/x din nou.", allowed);
  assert.deepEqual(bad.map((e) => e.rule), ["link_not_from_search", "link_not_from_search"]);
  assert.match(bad[0]!.message, /invented\.example\/x/);
  assert.match(bad[1]!.message, /www\.also-invented\.ro\/y/);
  assert.equal(validateLinksFromSearch("https://bnr.ro/altceva", allowed).length, 1);
  // With nothing allowed (a news request without a brief) every link is a fault.
  assert.equal(validateLinksFromSearch("https://www.bnr.ro/comunicat", new Set()).length, 1);
});
