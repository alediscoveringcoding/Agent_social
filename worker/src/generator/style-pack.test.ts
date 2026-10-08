import "../test-support/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PLATFORMS } from "../platforms.js";
import { PLATFORM_RULES, buildSystemPrompt, buildUserPrompt } from "./prompts.js";
import { EXAMPLE_GUARD, loadStylePack, selectExamples } from "./style-pack.js";

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
});
