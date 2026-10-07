import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MANUAL_ONLY_PLATFORMS, PLATFORMS, PLATFORM_KIND, POSTIZ_PROVIDER, PROVIDER_TO_PLATFORM } from "../platforms.js";
import { ModelDraftSchema, draftSchema, parseModelResponse } from "./schema.js";
import { LENGTH_LIMITS, validateContent, validateVariantFields } from "./validators.js";
import { measurePlatformLength } from "./text-length.js";
import { buildSystemPrompt } from "./prompts.js";
import { validateDraft } from "../loops/generator.js";
import { modelDraft, variant } from "../test-support/drafts.js";

const NEW_PLATFORMS = ["threads", "bluesky", "mastodon", "linkedin", "reddit", "pinterest", "telegram", "discord", "medium", "farcaster", "nostr", "lemmy"] as const;
const BATCH2 = ["slack", "wordpress", "listmonk", "vk", "gmb", "tumblr", "dribbble", "mewe", "skool", "whop", "moltbook", "kick", "twitch", "tiktok", "youtube"] as const;

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

test("the generator schema lists every platform, and the worker's tables agree with each other", () => {
  const platformSchema = (draftSchema as any).properties.drafts.items.properties.variants.items.properties.platform;
  assert.deepEqual([...platformSchema.enum].sort(), [...PLATFORMS].sort());
  for (const p of NEW_PLATFORMS) assert.ok((PLATFORMS as readonly string[]).includes(p), p);
  assert.equal(PLATFORMS.length, 35);
  for (const p of BATCH2) assert.ok((PLATFORMS as readonly string[]).includes(p), p);
  assert.deepEqual(Object.keys(PLATFORM_KIND).sort(), [...PLATFORMS].sort());
  assert.equal(PLATFORM_KIND.medium, "article");
  for (const p of NEW_PLATFORMS) if (p !== "medium") assert.equal(PLATFORM_KIND[p], "social", p);
  // Every automatic platform has a Postiz provider; the two manual-only ones do not.
  for (const p of PLATFORMS) assert.equal(POSTIZ_PROVIDER[p] === undefined, p === "substack" || p === "producthunt", p);
  assert.deepEqual([...MANUAL_ONLY_PLATFORMS], ["substack", "producthunt", "youtube"], "YouTube needs video: manual only");
  assert.equal(PLATFORM_KIND.wordpress, "article");
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

test("a draft with a variant for every platform parses, and the model's title and link become settings", () => {
  const variants = PLATFORMS.map((p) => variant(p, PLATFORM_KIND[p] !== "social" ? "" : "Text scurt", p === "reddit" ? { title: "Un titlu pentru Reddit" } : p === "pinterest" ? { title: "Un titlu de pin", link: "https://thecrypto.support/ghid/x" } : p === "lemmy" ? { title: "Un titlu pentru Lemmy" } : {}));
  const model = modelDraft({ variants });
  assert.doesNotThrow(() => ModelDraftSchema.parse(model));
  const parsed = parseModelResponse(JSON.stringify({ drafts: [{ ...model, variants: variants.map((v) => ({ ...v, platform: v.platform.toUpperCase() })) }] }));
  assert.equal(parsed[0].variants.length, 35);

  const draft = validateDraft({ ...model, kind: "social", article: null, launch: null }, 0, "taxes-support");
  const by = (platform: string) => draft.variants.find((v: any) => v.platform === platform);
  assert.deepEqual(by("reddit").settings, { post_type: "self", title: "Un titlu pentru Reddit" });
  assert.deepEqual(by("pinterest").settings, { title: "Un titlu de pin", link: "https://thecrypto.support/ghid/x" });
  assert.deepEqual(by("lemmy").settings, { title: "Un titlu pentru Lemmy" });
  assert.deepEqual(by("instagram").settings, { post_type: "post" });
  assert.deepEqual(by("x").settings, { who_can_reply: "everyone" });
  assert.deepEqual(by("bluesky").settings, {});
  for (const v of draft.variants) assert.ok(!("title" in v) && !("link" in v), "title and link are not sent as variant fields");
});

test("the worker's platform list, kinds, provider map and limits mirror the site", () => {
  const constants = readFileSync(new URL("../../../site/src/lib/social/constants.ts", import.meta.url), "utf8");
  const block = (name: string, open = "[", close = "]") => {
    const start = constants.indexOf(`export const ${name}`);
    assert.ok(start >= 0, name);
    const from = constants.indexOf(open, constants.indexOf("=", start));
    return constants.slice(from, constants.indexOf(close, from));
  };
  const sitePlatforms = [...block("PLATFORMS").matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(sitePlatforms, [...PLATFORMS]);
  const siteProviders = Object.fromEntries([...block("PROVIDER_TO_PLATFORM", "{", "\n}").matchAll(/^\s*'?([\w.-]+)'?:\s*'([\w-]+)',?\s*$/gm)].map((m) => [m[1], m[2]]));
  assert.deepEqual(siteProviders, PROVIDER_TO_PLATFORM);
  const siteKinds = Object.fromEntries([...block("PLATFORM_KIND", "{", "\n}").matchAll(/^\s*'?([\w-]+)'?:\s*'(\w+)',?\s*$/gm)].map((m) => [m[1], m[2]]));
  assert.deepEqual(siteKinds, PLATFORM_KIND);

  const validation = readFileSync(new URL("../../../site/src/lib/social/validation.ts", import.meta.url), "utf8");
  const limitsBlock = validation.slice(validation.indexOf("export const PLATFORM_MAX_LENGTH"), validation.indexOf("export const MAX_IMAGES"));
  const siteLimits = Object.fromEntries([...limitsBlock.matchAll(/^\s*'?([\w-]+)'?:\s*(\d+),/gm)].map((m) => [m[1], Number(m[2])]));
  // Product Hunt's 260 is the launch description, checked as a launch field.
  for (const [platform, limit] of Object.entries(siteLimits)) if (platform !== "producthunt") assert.equal(LENGTH_LIMITS[platform], limit, `limit of ${platform}`);
  for (const p of NEW_PLATFORMS) assert.ok(p in siteLimits, `site limit for ${p}`);
  for (const p of BATCH2) if (p !== "listmonk") assert.ok(p in siteLimits, `site limit for ${p}`);
  const manual = [...block("MANUAL_ONLY_PLATFORMS").matchAll(/'([\w-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(manual, [...MANUAL_ONLY_PLATFORMS], "the manual-only list matches the site");
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

test("the system prompt covers the new platforms and kinds", () => {
  const system = buildSystemPrompt({ slug: "taxes-support", name: "Taxes Support" }, {});
  for (const p of NEW_PLATFORMS) assert.ok(system.includes(p), `prompt mentions ${p}`);
  assert.ok(system.includes("article (devto, hashnode, substack, medium, wordpress, listmonk)"));
  for (const p of BATCH2) assert.ok(system.includes(p), `prompt mentions ${p}`);
  assert.ok(system.includes("variant.title") && system.includes("variant.link"));
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
