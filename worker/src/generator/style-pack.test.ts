import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PLATFORMS } from "../platforms.js";
import { PLATFORM_RULES, buildSystemPrompt, buildUserPrompt } from "./prompts.js";
import type { ResearchBrief } from "./research-types.js";
import { EXAMPLE_GUARD, ORIGINAL_MAX_CHARS, capOriginal, loadContentTypes, loadPublicBrand, loadStylePack, selectExamples } from "./style-pack.js";

const brand = { slug: "taxes-support", name: "Taxes Support" };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "style-pack-"));
function write(root: string, rel: string, text: string) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
const section = (prompt: string, title: string) => prompt.slice(prompt.indexOf(title));

test("PLATFORM_RULES covers every platform", () => {
  for (const p of PLATFORMS) assert.ok(PLATFORM_RULES[p], p);
  assert.equal(Object.keys(PLATFORM_RULES).length, PLATFORMS.length);
});

test("no pack: the prompt is generic, public and deterministic", () => {
  const input = { platforms: ["linkedin", "instagram", "x"] };
  const a = buildSystemPrompt(brand, input);
  assert.equal(a, buildSystemPrompt(brand, input));
  assert.equal(a, buildSystemPrompt(brand, input, loadStylePack("taxes-support", "/nonexistent/dir")));
  assert.match(a, /Write for "Taxes Support"/);
  assert.ok(!a.includes("EXAMPLES"));
  assert.ok(!a.includes("[Brand line]") && !/private/i.test(a));
  assert.ok(a.includes("UNIVERSAL WRITING RULES") && a.includes("SELF-CHECK") && a.includes("CONTENT TYPES"));
  assert.ok(a.includes("Line 1 is the hook"), "instagram playbook");
});

test("an unknown brand with no profile still gets a generic prompt", () => {
  const p = buildSystemPrompt({ slug: "nobody", name: "Nobody" }, { platforms: ["x"] });
  assert.match(p, /Write for "Nobody"/);
});

test("the prompt names only the targeted platforms", () => {
  const p = buildSystemPrompt(brand, { platforms: ["linkedin", "x"], kinds: ["social"] });
  const platforms = section(p, "PLATFORMS (");
  assert.ok(platforms.includes("- linkedin:") && platforms.includes("- x:"));
  for (const other of ["instagram", "threads", "bluesky", "telegram", "tiktok", "press"]) assert.ok(!p.includes(`- ${other}:`), other);
  assert.ok(!p.includes("article.title"), "article kind omitted when not requested");
  assert.ok(p.length < buildSystemPrompt(brand, {}).length);
});

test("a temporary pack overrides voice, language, CTA and hashtags and merges the rest", () => {
  const dir = tmp();
  write(dir, "taxes-support/brand.yaml", [
    "voice: |", "  PACK VOICE LINE", "language:", "  platforms: { linkedin: en }", "  card: en",
    "cta:", "  instagram: PACK IG CTA", "hashtags:", "  instagram: ['#packtag']", "bullet: '-'", "emoji: bullets-only",
    "avoid: ['Pack cliche']", "disclaimer: PACK DISCLAIMER", "",
  ].join("\n"));
  const style = loadStylePack("taxes-support", dir);
  assert.equal(style.brand?.name, "Taxes Support", "public key survives");
  assert.equal(style.brand?.language?.default, "ro", "default survives the merge");
  assert.equal(style.brand?.language?.platforms?.linkedin, "en");
  assert.ok(style.brand?.cta?.default, "public default CTA survives");
  const p = buildSystemPrompt(brand, { platforms: ["linkedin", "instagram", "x"] }, style);
  assert.ok(p.includes("PACK VOICE LINE") && !p.includes("Explain, do not scare"));
  assert.match(p, /- linkedin: English/);
  assert.match(p, /- instagram, x: Romanian without diacritics/);
  assert.match(p, /card text: English/);
  assert.match(p, /- instagram: PACK IG CTA/);
  assert.match(p, /- linkedin: Afli mai multe/, "default CTA applies to linkedin");
  assert.match(p, /- instagram: #packtag/);
  assert.ok(p.includes("Emoji: only as list markers") && p.includes("Pack cliche") && p.includes("PACK DISCLAIMER"));
});

test("platform notes follow the public playbook; linkedin-page uses the linkedin files", () => {
  const dir = tmp();
  write(dir, "taxes-support/platforms/linkedin.md", "PACK LINKEDIN NOTE");
  const p = buildSystemPrompt(brand, { platforms: ["linkedin-page"] }, loadStylePack("taxes-support", dir));
  assert.ok(p.indexOf("150-220 words") < p.indexOf("PACK LINKEDIN NOTE"));
});

test("examples: targeted platforms only, at most 2 each, guard text, order and budget", () => {
  const dir = tmp();
  for (const n of ["01-a", "02-b", "03-c"]) write(dir, `taxes-support/examples/linkedin/${n}.md`, `LI ${n} post`);
  write(dir, "taxes-support/examples/instagram/01-a.md", "---\ncontent_type: explainer\nnote: why\n---\nIG body text");
  write(dir, "taxes-support/examples/threads/01-a.md", "THREADS secret");
  const style = loadStylePack("taxes-support", dir);
  const p = buildSystemPrompt(brand, { platforms: ["linkedin", "instagram"] }, style);
  assert.ok(p.includes(EXAMPLE_GUARD));
  assert.ok(p.includes("LI 01-a post") && p.includes("LI 02-b post") && !p.includes("LI 03-c post"));
  assert.ok(p.includes("IG body text") && !p.includes("note: why") && p.includes("[instagram, explainer]"));
  assert.ok(!p.includes("THREADS secret"));
  assert.ok(p.indexOf(EXAMPLE_GUARD) > p.indexOf("PLATFORMS (") && p.indexOf(EXAMPLE_GUARD) < p.indexOf("CARDS:"));
  const big = tmp();
  write(big, "taxes-support/examples/linkedin/01.md", "a".repeat(5000));
  write(big, "taxes-support/examples/linkedin/02.md", "b".repeat(5000));
  write(big, "taxes-support/examples/instagram/01.md", "c".repeat(100));
  const picked = selectExamples(loadStylePack("taxes-support", big), ["linkedin", "instagram"]);
  assert.deepEqual(picked.map(x => path.basename(x.example.file)), ["01.md"], "later files drop first");
  assert.ok(!buildSystemPrompt(brand, { platforms: ["x"] }, style).includes("EXAMPLES"));
});

test("invalid files throw errors that name the file", () => {
  const dir = tmp();
  const bad = write(dir, "taxes-support/brand.yaml", "voice: [unclosed\n");
  assert.throws(() => loadStylePack("taxes-support", dir), (e: Error) => e.message.includes(bad));
  const unknown = write(dir, "taxes-support/brand.yaml", "voice: ok\ntagline: nope\n");
  assert.throws(() => loadStylePack("taxes-support", dir), (e: Error) => e.message.includes(unknown) && e.message.includes("tagline"));
  const badLang = write(dir, "taxes-support/brand.yaml", "language: { default: fr }\n");
  assert.throws(() => loadStylePack("taxes-support", dir), (e: Error) => e.message.includes(badLang));
  write(dir, "taxes-support/brand.yaml", "voice: ok\n");
  const ex = write(dir, "taxes-support/examples/x/01.md", "---\nmood: sad\n---\ntext");
  assert.throws(() => loadStylePack("taxes-support", dir), (e: Error) => e.message.includes(ex));
});

test("a missing pack directory or brand folder is generic only", () => {
  const dir = tmp();
  assert.deepEqual(loadStylePack("taxes-support", path.join(dir, "none")).examples, {});
  const style = loadStylePack("taxes-support", dir);
  assert.equal(style.brand?.name, "Taxes Support");
});

test("the user prompt asks for a different content type per draft", () => {
  const p = buildUserPrompt({ source: { type: "topic", topic: "T" }, platforms: ["x"], count: 3 });
  assert.match(p, /different content type/);
});

test("the committed private.example pack loads", () => {
  const style = loadStylePack("example-brand", path.resolve(import.meta.dirname, "../../../prompts/private.example"));
  assert.equal(style.brand?.name, "[Brand name]");
  assert.equal(style.examples.linkedin?.length, 1);
  assert.deepEqual(style.originals, {}, "original/README.md is documentation, not a brief");
  assert.deepEqual(style.brand?.news_topics, ["[Search theme]"]);
});

const research: ResearchBrief = {
  text: "STORY 1: Example Corp exits\nFacts:\n- Example Corp withdrew on 3 May 2027 [S1]\n- It had 5 million users [S2]",
  sources: [
    { id: "S1", url: "https://example.com/release", title: "Example Corp statement", publisher: "Example Corp", published_at: "3 May 2027", cited_text: "" },
    { id: "S2", url: "https://news.example.org/a", title: "Users leave", publisher: "", published_at: "", cited_text: "" },
  ],
  searches: 2, provider: "claude", model: "test-model",
};

test("originals load by playbook key; README is ignored; BOM and CRLF are normalised", () => {
  const dir = tmp();
  write(dir, "taxes-support/original/linkedin.md", "﻿LI BRIEF\r\nline two\r\n");
  write(dir, "taxes-support/original/instagram.md", "IG BRIEF");
  write(dir, "taxes-support/original/README.md", "docs only");
  write(dir, "taxes-support/original/empty.md", "   \n");
  const style = loadStylePack("taxes-support", dir);
  assert.deepEqual(Object.keys(style.originals).sort(), ["instagram", "linkedin"]);
  assert.equal(style.originals.linkedin, "LI BRIEF\nline two");
  const page = tmp();
  write(page, "taxes-support/original/linkedin-page.md", "PAGE BRIEF");
  assert.deepEqual(loadStylePack("taxes-support", page).originals, { linkedin: "PAGE BRIEF" }, "linkedin-page maps to linkedin");
  assert.deepEqual(loadStylePack("taxes-support", path.join(dir, "none")).originals, {});
  assert.deepEqual(loadStylePack("taxes-support", tmp()).originals, {}, "brand folder missing");
});

test("only the targeted platforms' originals reach the prompt, between the platform rules and the examples", () => {
  const dir = tmp();
  write(dir, "taxes-support/original/linkedin.md", "LI BRIEF TEXT");
  write(dir, "taxes-support/original/instagram.md", "IG BRIEF TEXT");
  write(dir, "taxes-support/original/threads.md", "THREADS BRIEF TEXT");
  write(dir, "taxes-support/examples/linkedin/01-a.md", "LI EXAMPLE");
  const style = loadStylePack("taxes-support", dir);
  const header = "OWNER'S ORIGINAL BRIEF FOR";
  const rule = "(authoritative for voice, selection and structure; the schema and content rules above win on conflicts)";

  const p = buildSystemPrompt(brand, { platforms: ["linkedin-page", "x"] }, style);
  assert.ok(p.includes(`${header} linkedin-page ${rule}`));
  assert.ok(p.includes("LI BRIEF TEXT") && !p.includes("IG BRIEF TEXT") && !p.includes("THREADS BRIEF TEXT"));
  assert.ok(p.indexOf("PLATFORMS (") < p.indexOf("LI BRIEF TEXT") && p.indexOf("LI BRIEF TEXT") < p.indexOf(EXAMPLE_GUARD));
  assert.ok(p.indexOf("LI BRIEF TEXT") < p.indexOf("CARDS:"));

  const both = buildSystemPrompt(brand, { platforms: ["instagram", "linkedin", "linkedin-page"] }, style);
  assert.equal(both.split(header).length - 1, 2, "one section per playbook, not per platform");
  assert.ok(both.includes(`${header} linkedin, linkedin-page ${rule}`) && both.includes("IG BRIEF TEXT"));

  const none = buildSystemPrompt(brand, { platforms: ["x"] }, style);
  assert.ok(!none.includes(header) && !none.includes("LI BRIEF TEXT"));
  assert.ok(!buildSystemPrompt(brand, { platforms: ["linkedin"] }).includes(header), "no pack, no originals");
});

test("each original is cut at the cap, at a paragraph break", () => {
  const dir = tmp();
  const para = `${"word ".repeat(40).trim()}.\n\n`;
  write(dir, "taxes-support/original/linkedin.md", para.repeat(Math.ceil((ORIGINAL_MAX_CHARS * 1.5) / para.length)));
  write(dir, "taxes-support/original/instagram.md", "short brief");
  const style = loadStylePack("taxes-support", dir);
  assert.ok(style.originals.linkedin.length <= ORIGINAL_MAX_CHARS, String(style.originals.linkedin.length));
  assert.ok(style.originals.linkedin.length > ORIGINAL_MAX_CHARS - 1000, "keeps almost all of the allowance");
  assert.ok(style.originals.linkedin.endsWith("[brief cut here: too long]"));
  assert.ok(style.originals.linkedin.replace("\n[brief cut here: too long]", "").endsWith("word."), "ends on a whole paragraph");
  assert.equal(style.originals.instagram, "short brief");
  assert.equal(capOriginal("abc", 10), "abc");
  assert.ok(capOriginal("x".repeat(200), 100).length <= 100, "no paragraph break: still capped");
});

test("news_topics: public list first, private additions after, no repeats", () => {
  const pub = tmp();
  write(pub, "brands/topical.yaml", "name: Topical\nnews_topics:\n  - Topic A\n  - Topic B\n");
  const priv = tmp();
  write(priv, "topical/brand.yaml", "news_topics:\n  - topic b\n  - Topic C\n");
  assert.deepEqual(loadStylePack("topical", priv, pub).brand?.news_topics, ["Topic A", "Topic B", "Topic C"]);
  assert.deepEqual(loadStylePack("topical", path.join(priv, "none"), pub).brand?.news_topics, ["Topic A", "Topic B"], "public only");
  const onlyPrivate = tmp();
  write(onlyPrivate, "topical/brand.yaml", "news_topics: [Only private]\n");
  assert.deepEqual(loadStylePack("topical", onlyPrivate, tmp()).brand?.news_topics, ["Only private"]);
  const bad = write(priv, "topical/brand.yaml", "news_topics: not a list\n");
  assert.throws(() => loadStylePack("topical", priv, pub), (e: Error) => e.message.includes(bad) && e.message.includes("news_topics"));
  assert.ok((loadPublicBrand("taxes-support")?.news_topics?.length ?? 0) >= 5, "the committed brands carry topics");
});

test("the news section of the content types is added for research and news requests only", () => {
  const { base, news } = loadContentTypes();
  assert.ok(base.includes("contrast-news:") && !base.includes("## News"));
  assert.ok(news.startsWith("## News") && news.includes("Audit:") && news.includes("Hooks:"));
  const plain = buildSystemPrompt(brand, { platforms: ["linkedin"], source: { type: "topic", topic: "t" } });
  assert.ok(plain.includes("CONTENT TYPES:") && !plain.includes("## News"));
  const forNews = buildSystemPrompt(brand, { platforms: ["linkedin"], source: { type: "news", topic: "", window_days: 7 } });
  assert.ok(forNews.includes("## News") && forNews.indexOf("## News") < forNews.indexOf("PLATFORMS ("));
  const forTopic = buildSystemPrompt(brand, { platforms: ["linkedin"], research: true, source: { type: "topic", topic: "t" } });
  assert.ok(forTopic.includes("## News"));
});

test("the user prompt renders the research brief, its sources and the source rules", () => {
  const input = { source: { type: "news", topic: "", window_days: 7 }, platforms: ["linkedin"], count: 3 };
  const p = buildUserPrompt(input, research);
  assert.ok(p.includes("RESEARCH BRIEF") && p.includes("Example Corp withdrew on 3 May 2027 [S1]"));
  assert.ok(p.includes("S1: Example Corp statement (Example Corp, 3 May 2027) https://example.com/release"));
  assert.ok(p.includes("S2: Users leave https://news.example.org/a"), "empty publisher and date are left out");
  for (const rule of ["Cite only ids listed above", "source_id", '"unverified"', "Never write a URL in post text", "primary sources", "absolute dates"]) {
    assert.ok(p.includes(rule), rule);
  }
  assert.match(p, /one draft per story[^\n]*at most 3/);
  assert.ok(p.indexOf("RESEARCH BRIEF") < p.indexOf("SOURCES (") && p.indexOf("SOURCES (") < p.indexOf("SOURCE RULES"));
  const topic = buildUserPrompt({ source: { type: "topic", topic: "T", hooks: [] }, platforms: ["x"], count: 2 }, research);
  assert.match(topic, /Create exactly 2 drafts/);
  assert.ok(topic.includes("SOURCE RULES"));
  const noSources = buildUserPrompt(input, { ...research, sources: [] });
  assert.ok(noSources.includes("the search returned none") && !noSources.includes("SOURCES (cite only"));
});

test("a news request with no brief says so plainly; other requests are unchanged", () => {
  const news = buildUserPrompt({ source: { type: "news", topic: "chips", window_days: 3 }, platforms: ["linkedin"], count: 2 });
  assert.ok(news.includes("NO RESEARCH BRIEF") && news.includes("do not invent"));
  assert.ok(news.includes("focus: chips"));
  assert.match(news, /Create exactly 2 drafts/);
  const topic = buildUserPrompt({ source: { type: "topic", topic: "T", hooks: ["a"] }, platforms: ["x"], count: 1 });
  assert.ok(!topic.includes("NO RESEARCH BRIEF") && !topic.includes("SOURCE RULES") && topic.includes("Hooks: a"));
});
