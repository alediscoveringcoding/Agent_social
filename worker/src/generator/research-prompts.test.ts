import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EXCERPT_MAX_CHARS, buildResearchPrompts, pickSections } from "./research-prompts.js";
import { loadStylePack } from "./style-pack.js";

const brand = { slug: "taxes-support", name: "Taxes Support" };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "research-prompts-"));
function write(root: string, rel: string, text: string) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const BRIEF = [
  "# Header line one", "# Header line two", "",
  "## 1. Cine esti", "AUDIENCE-ONLY TEXT", "",
  "## 2. Ce tipuri de stiri alegi", "SELECTION RULE TEXT", "",
  "## 3. Hook-ul", "HOOK-ONLY TEXT", "",
  "## 4. Acuratetea: regula", "ACCURACY RULE TEXT", "",
  "## 5. Cardul", "CARD-ONLY TEXT", "",
].join("\n");

function pack(): ReturnType<typeof loadStylePack> {
  const dir = tmp();
  write(dir, "taxes-support/brand.yaml", "audience: PACK AUDIENCE\nnews_topics:\n  - Private theme\n");
  write(dir, "taxes-support/original/linkedin.md", BRIEF.replace("SELECTION RULE TEXT", "LINKEDIN SELECTION"));
  write(dir, "taxes-support/original/instagram.md", BRIEF.replace("SELECTION RULE TEXT", "INSTAGRAM SELECTION"));
  write(dir, "taxes-support/original/threads.md", BRIEF.replace("SELECTION RULE TEXT", "THREADS SELECTION"));
  return loadStylePack("taxes-support", dir);
}

const news = (over: Record<string, unknown> = {}) => ({
  source: { type: "news", topic: "", window_days: 14 }, platforms: ["linkedin"], count: 4, today: "2027-05-15", ...over,
});

test("pickSections keeps selection, audit and accuracy sections only", () => {
  const picked = pickSections(BRIEF);
  assert.ok(picked.includes("SELECTION RULE TEXT") && picked.includes("ACCURACY RULE TEXT"));
  for (const left of ["AUDIENCE-ONLY", "HOOK-ONLY", "CARD-ONLY", "Header line"]) assert.ok(!picked.includes(left), left);
  assert.ok(pickSections("## Story types\nA\n\n## Facts and accuracy\nB\n\n## Hooks\nC").includes("B"));
  assert.equal(pickSections("no headings at all"), "");
  assert.ok(pickSections(`## Acuratetea\n${"x\n".repeat(EXCERPT_MAX_CHARS)}`).length <= EXCERPT_MAX_CHARS);
});

test("the prompts carry the window, the topics, the audience and the research rules", () => {
  const { system, user } = buildResearchPrompts(brand, news(), pack());
  assert.ok(user.includes("up to 4 stories"));
  assert.ok(user.includes("from 2027-05-01 to 2027-05-15") && user.includes("the last 14 days"));
  assert.ok(user.includes("on the brand topics") && user.includes("Today is 2027-05-15"));
  assert.ok(user.includes("linkedin"));
  assert.ok(system.includes("AUDIENCE: PACK AUDIENCE"));
  assert.ok(system.includes("- Private theme"), "private topic");
  assert.ok(system.includes("crypto taxation in Romania"), "public topic");
  assert.ok(system.includes("Primary sources first") && system.includes("Never invent a URL"));
  assert.ok(system.includes("Proposed is not approved") && system.includes("adds the marker [S#]") && system.includes("Never write markers"));
  assert.ok(system.includes("NEWS AUDIT") && system.includes("Entity clarity") && system.includes("keep only 9 or 10"));
  assert.ok(!system.includes("LinkedIn news post, in this order"), "post bodies are the writer's business");
});

test("a focus replaces the generic wording; the window and count are clamped", () => {
  const focus = buildResearchPrompts(brand, news({ source: { type: "news", topic: "stablecoin delistings", window_days: 7 } }), pack());
  assert.ok(focus.user.includes("about: stablecoin delistings") && !focus.user.includes("on the brand topics"));
  const wide = buildResearchPrompts(brand, news({ source: { type: "news", topic: "", window_days: 400 }, count: 99 }), pack());
  assert.ok(wide.user.includes("the last 30 days") && wide.user.includes("up to 10 stories"));
  const dflt = buildResearchPrompts(brand, { source: { type: "news", topic: "" }, platforms: ["x"], today: "2027-05-15" });
  assert.ok(dflt.user.includes("the last 7 days") && dflt.user.includes("up to 3 stories"));
  const topic = buildResearchPrompts(brand, { source: { type: "topic", topic: "A topic", hooks: [] }, platforms: ["x"], count: 2 });
  assert.ok(topic.user.includes("Research this topic: A topic") && !topic.user.includes("the last"));
  const article = buildResearchPrompts(brand, { source: { type: "article", url: "https://example.com/post" }, platforms: ["x"], count: 1 });
  assert.ok(article.user.includes("https://example.com/post"));
});

test("only the targeted platforms' selection and accuracy sections are included", () => {
  const style = pack();
  const li = buildResearchPrompts(brand, news({ platforms: ["linkedin-page", "linkedin"] }), style).system;
  assert.ok(li.includes("LINKEDIN SELECTION") && li.includes("ACCURACY RULE TEXT"));
  assert.equal(li.split("OWNER'S SELECTION AND ACCURACY RULES FOR linkedin").length - 1, 1, "one excerpt per playbook");
  assert.ok(!li.includes("INSTAGRAM SELECTION") && !li.includes("THREADS SELECTION"));
  for (const left of ["AUDIENCE-ONLY", "HOOK-ONLY", "CARD-ONLY"]) assert.ok(!li.includes(left), left);
  const both = buildResearchPrompts(brand, news({ platforms: ["instagram", "linkedin"] }), style);
  assert.ok(both.system.includes("INSTAGRAM SELECTION") && both.system.includes("LINKEDIN SELECTION"));
  assert.ok(both.user.includes("instagram, linkedin"));
  const other = buildResearchPrompts(brand, news({ platforms: ["x"] }), style).system;
  assert.ok(!other.includes("OWNER'S SELECTION") && !other.includes("LINKEDIN SELECTION"));
});

test("without a pack the prompts use the public brand profile and stay short", () => {
  const { system, user } = buildResearchPrompts(brand, news({ platforms: ["linkedin", "instagram"] }));
  assert.ok(system.includes("Retail crypto holders in Romania"), "public audience");
  assert.ok(system.includes("DAC8 crypto reporting"), "public topics");
  assert.ok(!system.includes("OWNER'S SELECTION"));
  assert.ok(system.length < 9000, String(system.length));
  assert.ok(user.length < 600, String(user.length));
  const unknown = buildResearchPrompts({ slug: "nobody", name: "Nobody" }, news());
  assert.ok(unknown.system.includes('BRAND: Nobody') && !unknown.system.includes("BRAND TOPICS"));
});

test("many platforms are listed up to a limit", () => {
  const { user } = buildResearchPrompts(brand, news({ platforms: ["x", "threads", "bluesky", "mastodon", "reddit", "telegram", "discord", "slack"] }));
  assert.ok(user.includes("and 2 more"));
});
