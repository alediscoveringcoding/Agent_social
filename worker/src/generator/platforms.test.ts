import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DROPPED_PLATFORMS, PLATFORMS, PLATFORM_KIND, WRITABLE_PLATFORMS } from "../platforms.js";
import { ModelDraftSchema, draftSchema, parseModelResponse } from "./schema.js";
import { LENGTH_LIMITS, validateContent, validateVariantFields } from "./validators.js";
import { measurePlatformLength } from "./text-length.js";
import { buildSystemPrompt } from "./prompts.js";
import { validateDraft } from "../loops/generator.js";
import { modelDraft, variant } from "../test-support/drafts.js";

const NEW_PLATFORMS = ["threads", "bluesky", "mastodon", "linkedin", "reddit", "pinterest", "telegram", "discord", "medium", "farcaster", "nostr", "lemmy"] as const;
const BATCH2 = ["slack", "wordpress", "listmonk", "vk", "gmb", "tumblr", "dribbble", "mewe", "skool", "whop", "moltbook", "kick", "twitch", "tiktok", "youtube"] as const;
const BATCH3 = ["quora", "linkedin-article", "tradingview", "investing", "indiehackers", "stackexchange", "github", "forum", "press"] as const;
const isDropped = (p: string) => (DROPPED_PLATFORMS as readonly string[]).includes(p);

/** Claude structured outputs: at most 24 optional parameters and 16 union-type parameters in the whole schema. */
function schemaStats(node: unknown): { optional: number; unions: number; maxLength: number } {
  const stats = { optional: 0, unions: 0, maxLength: 0 };
  const walk = (n: any) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== "object") return;
    if (n.properties && typeof n.properties === "object") {
      const required = new Set<string>(n.required ?? []);
      for (const key of Object.keys(n.properties)) if (!required.has(key)) stats.optional++;
    }
    if (Array.isArray(n.anyOf) || Array.isArray(n.oneOf) || Array.isArray(n.type)) stats.unions++;
    if ("maxLength" in n) stats.maxLength++;
    Object.values(n).forEach(walk);
  };
  walk(node);
  return stats;
}

test("the generator schema lists the platforms that were kept, and the worker's tables agree with each other", () => {
  const platformSchema = (draftSchema as any).properties.drafts.items.properties.variants.items.properties.platform;
  assert.deepEqual([...platformSchema.enum].sort(), [...WRITABLE_PLATFORMS].sort());
  assert.equal(PLATFORMS.length, 44, "older drafts may still name a dropped platform");
  assert.deepEqual([...DROPPED_PLATFORMS], ["threads", "reddit", "pinterest", "nostr", "vk", "gmb", "tumblr", "dribbble", "whop", "moltbook", "kick", "twitch", "wordpress", "discord", "mastodon"]);
  assert.equal(WRITABLE_PLATFORMS.length, 29);
  for (const p of PLATFORMS) assert.equal((WRITABLE_PLATFORMS as readonly string[]).includes(p), !isDropped(p), p);
  assert.deepEqual(Object.keys(PLATFORM_KIND).sort(), [...PLATFORMS].sort());
  assert.equal(PLATFORM_KIND.medium, "article");
  for (const p of NEW_PLATFORMS) if (p !== "medium") assert.equal(PLATFORM_KIND[p], "social", p);
  assert.equal(PLATFORM_KIND.listmonk, "article");
});

test("the schema stays inside the Claude structured-output limits and has no maxLength for Gemini", () => {
  const stats = schemaStats(draftSchema);
  assert.ok(stats.optional <= 24, `optional parameters: ${stats.optional}`);
  assert.ok(stats.unions <= 16, `union-type parameters: ${stats.unions}`);
  assert.equal(stats.optional, 0, "absent values are empty strings, not optional parameters");
  assert.equal(stats.unions, 2, "only article and launch are nullable");
  assert.equal(stats.maxLength, 0, "Gemini responseJsonSchema rejects maxLength");
});

test("a draft with a variant for every kept platform parses, and the model's title and link become settings", () => {
  const variants = WRITABLE_PLATFORMS.map((p) => variant(p, PLATFORM_KIND[p] !== "social" ? "" : "Text scurt", p === "lemmy" ? { title: "Un titlu pentru Lemmy" } : {}));
  const model = modelDraft({ variants });
  assert.doesNotThrow(() => ModelDraftSchema.parse(model));
  const parsed = parseModelResponse(JSON.stringify({ drafts: [{ ...model, variants: variants.map((v) => ({ ...v, platform: v.platform.toUpperCase() })) }] }));
  assert.equal(parsed[0].variants.length, 29);
  for (const p of DROPPED_PLATFORMS) {
    assert.throws(() => ModelDraftSchema.parse(modelDraft({ variants: [variant(p as any, "Text")] })), p);
  }

  const draft = validateDraft({ ...model, kind: "social", article: null, launch: null }, 0, "taxes-support");
  const by = (platform: string) => draft.variants.find((v: any) => v.platform === platform);
  assert.deepEqual(by("lemmy").settings, { title: "Un titlu pentru Lemmy" });
  assert.deepEqual(by("instagram").settings, { post_type: "post" });
  assert.deepEqual(by("x").settings, { who_can_reply: "everyone" });
  assert.deepEqual(by("bluesky").settings, {});
  for (const v of draft.variants) assert.ok(!("title" in v) && !("link" in v), "title and link are not sent as variant fields");
});

test("the worker's platform list, dropped list, kinds and limits mirror the site", () => {
  const constants = readFileSync(new URL("../../../site/src/lib/social/constants.ts", import.meta.url), "utf8");
  const block = (name: string, open = "[", close = "]") => {
    const start = constants.indexOf(`export const ${name}`);
    assert.ok(start >= 0, name);
    const from = constants.indexOf(open, constants.indexOf("=", start));
    return constants.slice(from, constants.indexOf(close, from));
  };
  const sitePlatforms = [...block("PLATFORMS").matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(sitePlatforms, [...PLATFORMS]);
  const siteDropped = [...block("DROPPED_PLATFORMS").matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(siteDropped, [...DROPPED_PLATFORMS], "the dropped list matches the site");
  const siteKinds = Object.fromEntries([...block("PLATFORM_KIND", "{", "\n}").matchAll(/^\s*'?([\w-]+)'?:\s*'(\w+)',?\s*$/gm)].map((m) => [m[1], m[2]]));
  assert.deepEqual(siteKinds, PLATFORM_KIND);

  const validation = readFileSync(new URL("../../../site/src/lib/social/validation.ts", import.meta.url), "utf8");
  const limitsBlock = validation.slice(validation.indexOf("export const PLATFORM_MAX_LENGTH"), validation.indexOf("export const MAX_IMAGES"));
  const siteLimits = Object.fromEntries([...limitsBlock.matchAll(/^\s*'?([\w-]+)'?:\s*(\d+),/gm)].map((m) => [m[1], Number(m[2])]));
  // Product Hunt's 260 is the launch description, checked as a launch field.
  for (const [platform, limit] of Object.entries(siteLimits)) if (platform !== "producthunt") assert.equal(LENGTH_LIMITS[platform], limit, `limit of ${platform}`);
  for (const p of NEW_PLATFORMS) assert.ok(p in siteLimits, `site limit for ${p}`);
  for (const p of BATCH2) if (p !== "listmonk") assert.ok(p in siteLimits, `site limit for ${p}`);
});

test("text limits per new platform, counted the platform's way", () => {
  const over = (platform: string, text: string) => validateContent(text, platform).some((e) => e.rule === "length");
  // threads, mastodon: 500
  assert.ok(!over("threads", "a".repeat(500)) && over("threads", "a".repeat(501)));
  // mastodon: a link counts 23
  assert.ok(!over("mastodon", "a".repeat(476) + " https://thecrypto.support/ghid/" + "x".repeat(200)));
  assert.ok(over("mastodon", "a".repeat(478) + " https://thecrypto.support/ghid/" + "x".repeat(200)));
  assert.equal(measurePlatformLength("mastodon", "https://thecrypto.support/ghid/" + "x".repeat(200)), 23);
  // bluesky: 300 graphemes (a family emoji is one), 3000 bytes
  assert.ok(!over("bluesky", "a".repeat(300)) && over("bluesky", "a".repeat(301)));
  assert.equal(measurePlatformLength("bluesky", "👨‍👩‍👧‍👦".repeat(10)), 10);
  assert.ok(!over("bluesky", "👨‍👩‍👧‍👦".repeat(300)), "300 graphemes is within the grapheme limit");
  assert.ok(validateContent("👨‍👩‍👧‍👦".repeat(300), "bluesky").some((e) => e.rule === "length_bytes"), "but 3000 bytes is exceeded");
  // farcaster: 320 UTF-8 bytes
  assert.ok(!over("farcaster", "a".repeat(320)) && over("farcaster", "a".repeat(321)));
  assert.ok(over("farcaster", "é".repeat(161)), "two bytes each");
  // the rest
  for (const [platform, limit] of [["linkedin", 3000], ["reddit", 10000], ["pinterest", 500], ["telegram", 4096], ["discord", 1980], ["lemmy", 10000]] as const) {
    assert.ok(!over(platform, "a".repeat(limit)), `${platform} at ${limit}`);
    assert.ok(over(platform, "a".repeat(limit + 1)), `${platform} over ${limit}`);
  }
  assert.ok(!over("nostr", "a".repeat(20000)) && !over("medium", "a".repeat(20000)));
});

test("titles: reddit, pinterest and lemmy need one inside their limits", () => {
  const rules = (platform: string, title: string) => validateVariantFields(platform, { title, link: "" }).map((e) => e.rule);
  assert.deepEqual(rules("reddit", "a".repeat(300)), []);
  assert.deepEqual(rules("reddit", ""), ["reddit_title"]);
  assert.deepEqual(rules("reddit", "a".repeat(301)), ["reddit_title"]);
  assert.deepEqual(rules("pinterest", "a".repeat(100)), []);
  assert.deepEqual(rules("pinterest", "a".repeat(101)), ["pinterest_title"]);
  assert.deepEqual(rules("lemmy", "abc"), []);
  assert.deepEqual(rules("lemmy", "ab"), ["lemmy_title"]);
  assert.deepEqual(rules("lemmy", "a".repeat(201)), ["lemmy_title"]);
  assert.deepEqual(rules("lemmy", "doua\nrANduri"), ["lemmy_title"]);
  assert.deepEqual(rules("threads", ""), []);

  const missing = validateDraft(modelDraft({ variants: [variant("reddit", "Text"), variant("pinterest", "Descriere")] }), 0, "taxes-support");
  assert.deepEqual(missing.validation_errors.filter((e) => e.rule.endsWith("_title")).map((e) => e.field), ["variants.reddit", "variants.pinterest"]);
});

test("medium is an article: it needs a subtitle and at most three tags of 25 characters", () => {
  const article = (subtitle: string, tags: string[]) => ({ title: "Titlu", subtitle, body_markdown: "Un ghid calm", tags, canonical_url: "https://thecrypto.support/ghid/x" });
  const ok = validateDraft(modelDraft({ kind: "article", article: article("Subtitlu", ["a", "b", "c"]), variants: [variant("medium", "")] }), 0, "taxes-support");
  assert.deepEqual(ok.validation_errors, []);
  const bad = validateDraft(modelDraft({ kind: "article", article: article("", ["a", "b", "c", "d"]), variants: [variant("medium", "")] }), 0, "taxes-support");
  assert.deepEqual(bad.validation_errors.map((e) => e.rule).sort(), ["article_tags_medium", "medium_subtitle"]);
  const longTag = validateDraft(modelDraft({ kind: "article", article: article("Subtitlu", ["x".repeat(26)]), variants: [variant("medium", "")] }), 0, "taxes-support");
  assert.deepEqual(longTag.validation_errors.map((e) => e.rule), ["article_tags_medium"]);
  // The body is the variant text for article platforms, so a long body is measured as the article.
  assert.equal(ok.variants[0].platform, "medium");
});

test("the system prompt covers the kept platforms and kinds, and no dropped platform", () => {
  const system = buildSystemPrompt({ slug: "taxes-support", name: "Taxes Support" }, {});
  const section = system.slice(system.indexOf("PLATFORMS (social variants"), system.indexOf("VARIANT FIELDS"));
  for (const p of WRITABLE_PLATFORMS) assert.ok(section.includes(`- ${p}:`), `prompt describes ${p}`);
  for (const p of DROPPED_PLATFORMS) assert.ok(!section.includes(`- ${p}:`), `prompt leaves out ${p}`);
  assert.ok(system.includes("article (devto, hashnode, substack, medium, listmonk)"));
  assert.ok(system.includes("variant.title") && system.includes("variant.link"));
  // A request that still names a dropped platform gets no rules for it.
  const old = buildSystemPrompt({ slug: "taxes-support", name: "Taxes Support" }, { platforms: ["reddit", "x"] });
  assert.ok(old.includes("- x:") && !old.includes("- reddit:"));
});

test("second batch: text limits per platform, in the platform's own unit", () => {
  const over = (platform: string, text: string) => validateContent(text, platform).some((e) => e.rule === "length");
  for (const [platform, limit] of [["slack", 40000], ["wordpress", 100000], ["vk", 2048], ["gmb", 1500], ["tumblr", 32768], ["dribbble", 40000], ["mewe", 63206], ["skool", 5000], ["whop", 50000], ["moltbook", 300], ["kick", 500], ["twitch", 500], ["tiktok", 2000], ["youtube", 5000]] as const) {
    assert.ok(!over(platform, "a".repeat(limit)), `${platform} at ${limit}`);
    assert.ok(over(platform, "a".repeat(limit + 1)), `${platform} over ${limit}`);
  }
  assert.ok(!over("listmonk", "a".repeat(200000)), "a newsletter has no practical limit");
});

test("second batch: titles for Dribbble, Skool, TikTok and YouTube; TikTok and YouTube caps", () => {
  const rules = (platform: string, title: string) => validateVariantFields(platform, { title, link: "" }).map((e) => e.rule);
  assert.deepEqual(rules("dribbble", "Un shot"), []);
  assert.deepEqual(rules("dribbble", ""), ["dribbble_title"]);
  assert.deepEqual(rules("skool", ""), ["skool_title"]);
  assert.deepEqual(rules("tiktok", ""), [], "a TikTok title is optional");
  assert.deepEqual(rules("tiktok", "a".repeat(90)), []);
  assert.deepEqual(rules("tiktok", "a".repeat(91)), ["tiktok_title"]);
  assert.deepEqual(rules("youtube", "a".repeat(100)), []);
  assert.deepEqual(rules("youtube", ""), ["youtube_title"]);
  assert.deepEqual(rules("youtube", "a".repeat(101)), ["youtube_title"]);
  assert.deepEqual(rules("slack", ""), []);
});

test("second batch: a draft with titles keeps them as settings; WordPress and Listmonk are articles", () => {
  const draft = validateDraft(modelDraft({
    variants: [variant("dribbble", "Descriere", { title: "Un shot" }), variant("tiktok", "Descriere", { title: "Titlu TikTok" }), variant("tumblr", "Text", { title: "Titlu", link: "https://thecrypto.support/x" }), variant("youtube", "Descriere", { title: "Un video" }), variant("slack", "Text")],
  }), 0, "taxes-support");
  const by = (p: string) => draft.variants.find((v: any) => v.platform === p);
  assert.deepEqual(by("dribbble").settings, { title: "Un shot" });
  assert.deepEqual(by("tiktok").settings, { title: "Titlu TikTok" });
  assert.deepEqual(by("tumblr").settings, { title: "Titlu", link: "https://thecrypto.support/x" });
  assert.deepEqual(by("youtube").settings, { title: "Un video" });
  assert.deepEqual(by("slack").settings, {});
  assert.deepEqual(draft.validation_errors, []);

  const article = { title: "Titlu", subtitle: "Subtitlu", body_markdown: "Un ghid calm", tags: ["a"], canonical_url: "https://thecrypto.support/ghid/x" };
  const ok = validateDraft(modelDraft({ kind: "article", article, variants: [variant("wordpress", ""), variant("listmonk", "")] }), 0, "taxes-support");
  assert.deepEqual(ok.validation_errors, []);
});

test("manual channels (amendment 05): kinds, limits and the title rules", () => {
  for (const p of BATCH3) {
    assert.ok((WRITABLE_PLATFORMS as readonly string[]).includes(p), p);
    assert.equal(PLATFORM_KIND[p], ["linkedin-article", "github", "press"].includes(p) ? "article" : "social", p);
  }
  const over = (platform: string, text: string) => validateContent(text, platform).some((e) => e.rule === "length");
  for (const [platform, limit] of [["quora", 20000], ["linkedin-article", 110000], ["tradingview", 10000], ["investing", 5000], ["indiehackers", 20000], ["stackexchange", 30000], ["github", 125000], ["forum", 20000], ["press", 50000]] as const) {
    assert.ok(!over(platform, "a".repeat(limit)), `${platform} at ${limit}`);
    assert.ok(over(platform, "a".repeat(limit + 1)), `${platform} over ${limit}`);
  }
  const rules = (platform: string, title?: string) => validateVariantFields(platform, { title }).map((e) => e.rule);
  assert.deepEqual(rules("tradingview"), ["tradingview_title"]);
  assert.deepEqual(rules("tradingview", "a".repeat(100)), []);
  assert.deepEqual(rules("tradingview", "a".repeat(101)), ["tradingview_title"]);
  assert.deepEqual(rules("indiehackers"), ["indiehackers_title"]);
  assert.deepEqual(rules("indiehackers", "a".repeat(151)), ["indiehackers_title"]);
  assert.deepEqual(rules("stackexchange"), [], "an answer has no title");
  assert.deepEqual(rules("stackexchange", "prea scurt"), ["stackexchange_title"]);
  assert.deepEqual(rules("stackexchange", "a".repeat(15)), []);
  assert.deepEqual(rules("forum"), [], "a reply has no title");

  const variants = [
    variant("tradingview", "Descriere", { title: "O idee calma" }),
    variant("stackexchange", "Sunt afiliat cu Taxes Support. Raspunsul explica pasii.", {}),
    variant("stackexchange", "Sunt afiliat cu Taxes Support. Intrebarea are context.", { title: "Cum declar castigurile din crypto?" }),
    variant("forum", "Un raspuns", {}),
    variant("forum", "Un fir nou", { title: "Declaratia Unica 2026" }),
    variant("quora", "Un raspuns", {}),
  ];
  const draft = validateDraft({ ...modelDraft({ variants }), kind: "social", article: null, launch: null }, 0, "taxes-support");
  const settings = draft.variants.map((v: any) => [v.platform, v.settings]);
  assert.deepEqual(settings, [
    ["tradingview", { title: "O idee calma" }],
    ["stackexchange", {}],
    ["stackexchange", { post_type: "question", title: "Cum declar castigurile din crypto?" }],
    ["forum", {}],
    ["forum", { title: "Declaratia Unica 2026" }],
    ["quora", {}],
  ]);
});

test("the prompt covers the manual channels and requires the Stack Exchange affiliation", () => {
  const prompt = buildSystemPrompt({ slug: "taxes-support", name: "Taxes Support" }, {});
  for (const p of BATCH3) assert.ok(prompt.includes(p), p);
  assert.match(prompt, /MUST disclose the affiliation/);
  assert.match(prompt, /press release/);
});
