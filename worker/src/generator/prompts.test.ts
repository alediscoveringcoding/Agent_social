import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "yaml";
import { LINK_IN_TEXT, NEEDS_CANONICAL, activeFacts, buildSystemPrompt, buildUserPrompt } from "./prompts.js";
import type { ResearchBrief } from "./research-types.js";
import { PROMPTS_DIR, addDays } from "./style-pack.js";

const brand = { slug: "taxes-support", name: "Taxes Support" };
const part = (prompt: string, title: string, next: string) => prompt.slice(prompt.indexOf(title), prompt.indexOf(next));

const research: ResearchBrief = {
  text: "STORY 1: Example Corp exits\nFacts:\n- Example Corp withdrew on 3 May 2027 [S1]",
  sources: [{ id: "S1", url: "https://example.com/release", title: "Example Corp statement", publisher: "Example Corp", published_at: "3 May 2027", cited_text: "" }],
  searches: 1, provider: "claude", model: "test-model",
};

// ---- expired facts and today's date ----

const FIXTURE = {
  rates: [
    { fact: "OLD RATE", valid_from: "2024-01-01", valid_to: "2025-12-31" },
    { fact: "CURRENT RATE", valid_from: "2026-01-01", valid_to: "2026-12-31" },
    { fact: "NEXT YEAR RATE", valid_from: "2027-01-01", valid_to: "2027-12-31" },
    { fact: "OPEN FROM", valid_from: "2026-06-01" },
    { fact: "OPEN TO", valid_to: "2026-06-30" },
  ],
  deadlines: [{ fact: "UNDATED DEADLINE", recurrence: "annual" }],
  old_only: [{ fact: "ONLY OLD", valid_to: "2020-01-01" }],
  note: "a plain value",
};
const names = (facts: Record<string, unknown>) => Object.values(facts).flat().map((f: any) => f?.fact).filter(Boolean);

test("activeFacts drops expired and not-yet-valid facts and keeps the rest", () => {
  assert.deepEqual(names(activeFacts(FIXTURE, "2026-07-10")).sort(), ["CURRENT RATE", "OPEN FROM", "UNDATED DEADLINE"].sort());
  assert.deepEqual(names(activeFacts(FIXTURE, "2026-06-15")).sort(), ["CURRENT RATE", "OPEN FROM", "OPEN TO", "UNDATED DEADLINE"].sort());
  assert.deepEqual(names(activeFacts(FIXTURE, "2026-12-31")).sort(), ["CURRENT RATE", "OPEN FROM", "UNDATED DEADLINE"].sort(), "valid through the last day");
  assert.deepEqual(names(activeFacts(FIXTURE, "2027-01-01")).sort(), ["NEXT YEAR RATE", "OPEN FROM", "UNDATED DEADLINE"].sort(), "valid from the first day");
  assert.deepEqual(names(activeFacts(FIXTURE, "2026-01-01")).sort(), ["CURRENT RATE", "OPEN TO", "UNDATED DEADLINE"].sort(), "OPEN FROM starts in June");
  const now = activeFacts(FIXTURE, "2026-07-10");
  assert.ok(!("old_only" in now), "a group with nothing left is dropped");
  assert.equal(now.note, "a plain value");
  assert.deepEqual(activeFacts(null, "2026-07-10"), {});
});

test("activeFacts fails visibly on a malformed validity date", () => {
  assert.throws(() => activeFacts({ g: [{ fact: "BAD", valid_to: "31.12.2025" }] }, "2026-01-01"), /valid_to must be YYYY-MM-DD.*BAD/);
  assert.throws(() => activeFacts({ g: [{ fact: "BAD", valid_from: "2026" }] }, "2026-01-01"), /valid_from must be YYYY-MM-DD/);
  assert.deepEqual(names(activeFacts({ g: [{ fact: "DATE OBJECT", valid_to: new Date("2026-02-01T00:00:00Z") }] }, "2026-02-01")), ["DATE OBJECT"]);
});

test("the writer prompt names today and lists only the facts valid today", () => {
  const real = yaml.parse(fs.readFileSync(path.join(PROMPTS_DIR, "facts.yaml"), "utf8"));
  const dated = Object.values(real).flat().filter((f: any) => f?.valid_to) as { fact: string; valid_to: string }[];
  assert.ok(dated.length > 0, "the committed facts carry a dated rate");
  for (const f of dated) {
    const lastDay = buildSystemPrompt(brand, { platforms: ["x"], today: f.valid_to });
    assert.ok(lastDay.includes(f.fact) && lastDay.includes(`Today is ${f.valid_to} (Europe/Bucharest).`), "still valid on its last day");
    const after = addDays(f.valid_to, 1);
    const expired = buildSystemPrompt(brand, { platforms: ["x"], today: after });
    assert.ok(!expired.includes(f.fact), `expired fact dropped on ${after}`);
    assert.ok(expired.includes(`Today is ${after} (Europe/Bucharest).`));
  }
  const p = buildSystemPrompt(brand, { platforms: ["x"], today: "2030-01-15" });
  assert.ok(p.includes("Declaratia Unica se depune pana pe 25 mai"), "an undated fact is always kept");
  assert.ok(p.includes("VERIFIED FACTS") && p.includes("do not state one from memory"));
  assert.ok(p.indexOf("Today is 2030-01-15 (Europe/Bucharest).") > p.indexOf("VERIFIED FACTS") && p.indexOf("Today is 2030-01-15") < p.indexOf("FIGURES:"));
  // Without a pinned date the line carries a real date.
  assert.match(buildSystemPrompt(brand, { platforms: ["x"] }), /Today is \d{4}-\d{2}-\d{2} \(Europe\/Bucharest\)\./);
});

test("the product facts use the current product name", () => {
  const text = fs.readFileSync(path.join(PROMPTS_DIR, "facts.yaml"), "utf8");
  assert.ok(text.includes("Taxes Support calculeaza automat") && !text.includes("The Crypto Support"));
  assert.match(text, /expired|ignore/i, "the file says expired facts are ignored");
});

// ---- the link rule ----

const readPlaybook = (name: string) => fs.readFileSync(path.join(PROMPTS_DIR, "style", "platforms", `${name}.md`), "utf8");

test("one link rule: at most one URL, on four platforms, the article URL or a brief source", () => {
  assert.deepEqual([...LINK_IN_TEXT], ["x", "facebook", "telegram", "bluesky"]);
  const p = buildSystemPrompt(brand, { platforms: ["x", "linkedin", "telegram"] });
  const links = part(p, "LINKS (", "SELF-CHECK");
  assert.ok(links.includes("The text of x, telegram may contain one URL"), "only the targeted link platforms are named");
  assert.ok(links.includes("request's article URL, exactly as given") && links.includes("most relevant source URL from the brief's SOURCES list, copied exactly"));
  assert.ok(links.includes("LinkedIn and Instagram included, has no URL in its text"));
  assert.ok(links.includes("first comment"));
  assert.ok(!links.includes("facebook") && !links.includes("bluesky"), "platforms that are not targeted stay out");
  assert.ok(buildSystemPrompt(brand, { platforms: ["linkedin", "instagram"] }).includes("No targeted platform carries a URL in its text."));
  assert.ok(buildSystemPrompt(brand, {}).includes("The text of x, facebook, telegram, bluesky may contain one URL"));

  for (const name of LINK_IN_TEXT) {
    const text = readPlaybook(name);
    assert.match(text, /(?:only|one) URL|only URL/i, `${name} playbook states the one-URL rule`);
    assert.ok(text.includes("article URL") && text.includes("source URL from the brief"), `${name} names which URL`);
    assert.ok(!/link (?:goes|sits) (?:last|in the text)\.?$/m.test(text), `${name} has no unconditional link line`);
  }
  for (const name of ["linkedin", "instagram"]) assert.match(readPlaybook(name), /no (?:links|URLs)/i);

  const selfCheck = fs.readFileSync(path.join(PROMPTS_DIR, "style", "self-check.md"), "utf8");
  assert.ok(selfCheck.includes("at most one URL") && selfCheck.includes("source URL from the research brief") && selfCheck.includes("LinkedIn, Instagram"));
  assert.ok(!selfCheck.includes("nor in any text whose platform rules ask for none"), "the old wording is gone");
});

test("the research source rules repeat the same link rule", () => {
  const p = buildUserPrompt({ source: { type: "topic", topic: "T", hooks: [] }, platforms: ["x"], count: 1 }, research);
  assert.ok(p.includes("x, facebook, telegram and bluesky") && p.includes("the most relevant source URL from the SOURCES list above"));
  assert.ok(p.includes("for an article request, the article URL") && p.includes("Never any other URL in post text"));
  assert.ok(!p.includes("except where a platform's rules ask for a link"), "the contradicting exception is gone");
});

// ---- canonical_url for devto, hashnode and medium ----

test("canonical_url is the request's article URL exactly; devto, hashnode and medium need an article request", () => {
  assert.deepEqual([...NEEDS_CANONICAL], ["devto", "hashnode", "medium"]);
  const system = buildSystemPrompt(brand, { platforms: ["devto", "x"], kinds: ["article"] });
  assert.ok(system.includes("canonical_url is the request's article URL on our blog, copied exactly as given"));
  assert.ok(system.includes("never a URL from the research brief or from memory"));
  assert.ok(system.includes("when the request's source is not an article, write no variant for them and say in notes"));

  const topic = buildUserPrompt({ source: { type: "topic", topic: "T", hooks: [] }, platforms: ["x", "devto", "medium"], count: 1 });
  assert.ok(topic.includes("Leave out devto, medium: each needs an article URL for canonical_url") && topic.includes("Write no variant for them"));
  assert.ok(buildUserPrompt({ source: { type: "news", topic: "", window_days: 7 }, platforms: ["hashnode"], count: 1 }, research).includes("Leave out hashnode:"));
  assert.ok(buildUserPrompt({ source: { type: "topic", topic: "T", hooks: [] }, platforms: ["x"], count: 1 }).includes("Target platforms: x\n"), "nothing to leave out");
  assert.ok(!buildUserPrompt({ source: { type: "topic", topic: "T", hooks: [] }, platforms: ["x"], count: 1 }).includes("Leave out"));

  const article = buildUserPrompt({ source: { type: "article", url: "https://blog.example.com/post" }, platforms: ["devto", "medium", "hashnode"], count: 1, kinds: ["article"] });
  assert.ok(!article.includes("Leave out"));
  assert.ok(article.includes("Source article: https://blog.example.com/post") && article.includes("Use exactly this URL as article.canonical_url"));
});

// ---- draft count ----

test("with a research brief the count is a ceiling; without one it is exact", () => {
  const sources = [
    { type: "news", topic: "", window_days: 7 },
    { type: "topic", topic: "T", hooks: [] },
    { type: "article", url: "https://blog.example.com/post" },
  ];
  for (const source of sources) {
    const withBrief = buildUserPrompt({ source, platforms: ["x"], count: 4 }, research);
    assert.match(withBrief, /Create up to 4 drafts, one per story or angle from the research brief/, source.type);
    assert.ok(withBrief.includes("If fewer than 4 qualify, write fewer drafts and say why in notes"), source.type);
    assert.ok(!withBrief.includes("exactly 4"), source.type);
  }
  assert.ok(buildUserPrompt({ source: sources[0], platforms: ["x"], count: 4 }, research).includes("strongest first"));
  assert.ok(!buildUserPrompt({ source: sources[1], platforms: ["x"], count: 4 }, research).includes("duel or before/after"));
  for (const source of sources) {
    // research: true without a brief, or no research at all: unchanged.
    assert.match(buildUserPrompt({ source, platforms: ["x"], count: 4 }), /Create exactly 4 drafts/, source.type);
  }
});

// ---- length (amendment 10) ----

test("one length per request, the same on every platform, after the briefs it overrides", () => {
  const long = buildSystemPrompt(brand, { platforms: ["linkedin", "instagram", "x", "telegram"], length: "long" });
  const section = part(long, "LENGTH (long form", "LINKS (one rule");
  assert.ok(section.includes("1200-2000 characters"));
  assert.ok(section.includes("x: 196-280") && section.includes("telegram: 716-1024"), "capped platforms fill most of their limit");
  assert.ok(!section.includes("linkedin:") && !section.includes("instagram:"), "the others share the common target");
  assert.ok(section.includes("wins over any length"));
  assert.ok(long.indexOf("LENGTH (") > long.indexOf("PLATFORMS ("), "after the playbooks and brand notes");
  assert.ok(!readPlaybook("linkedin").match(/\d+-\d+ words/) && !readPlaybook("instagram").match(/\d[\d,]*-\d[\d,]* characters/), "no playbook sets its own length");

  const short = buildSystemPrompt(brand, { platforms: ["facebook", "x"], length: "short" });
  assert.ok(part(short, "LENGTH (short form", "LINKS (one rule").includes("250-600 characters"));
  assert.ok(buildSystemPrompt(brand, { platforms: ["x"] }).includes("LENGTH (long form"), "a request without the field is long");

  const user = buildUserPrompt({ source: { type: "topic", topic: "T", hooks: [] }, platforms: ["x", "reddit"], count: 2, length: "short" });
  assert.ok(user.includes("Length: short form, 250-600 characters"));
  assert.ok(user.includes("Target platforms: x\n"), "a dropped platform left in an old request is not targeted");
});

test("a later batch is told what the earlier ones wrote", () => {
  const source = { type: "topic", topic: "T", hooks: [] };
  const first = buildUserPrompt({ source, platforms: ["x"], count: 3 });
  assert.ok(!first.includes("Already written"));
  const next = buildUserPrompt({ source, platforms: ["x"], count: 2 }, undefined, [{ headline: "Titlu unu", opening: "Prima propozitie." }]);
  assert.ok(next.includes("Already written for this request in an earlier call"));
  assert.ok(next.includes("- Titlu unu: Prima propozitie."));
  assert.match(next, /Create exactly 2 drafts/);
});
