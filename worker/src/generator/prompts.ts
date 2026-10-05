import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "yaml";
import { draftSchema } from "./schema.js";

const PROMPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../prompts");
// Ship these with the worker; missing policy files must fail visibly.
const facts = yaml.parse(fs.readFileSync(path.join(PROMPTS_DIR, "facts.yaml"), "utf8"));
const banned = fs.readFileSync(path.join(PROMPTS_DIR, "banned.txt"), "utf8").split("\n").map(s => s.trim()).filter(Boolean);

const BRAND_NAMES: Record<string, string> = {
  "taxes-support": "Taxes Support", "the-crypto-support": "The Crypto Support", "comets-of-web3": "Comets of Web3",
};
export function brandFromSlug(slug: string): { slug: string; name: string } {
  return { slug, name: BRAND_NAMES[slug] ?? slug };
}

export function buildSystemPrompt(brand: { slug: string; name: string }, _input: unknown): string {
  return `Write for "${brand.name}", a Romanian crypto tax brand.
VOICE: Romanian without diacritics, informal "tu", direct, calm and reassuring. Never hype, price predictions or investment advice.
Use the exact brand name. Domains only inside http(s) URLs, never in running text.
BANNED PHRASES:\n${banned.map(b => `- ${b}`).join("\n")}
VERIFIED FACTS (cite source "facts"):\n${yaml.stringify(facts)}
FIGURES: List every number, percentage, amount or date you use, including article, launch and card fields.
Keep verified facts as source "facts", numbers actually present in the source as "article", anything else as "unverified".
Do not invent facts from an article URL when no source contents are available. Mark unverifiable claims "unverified" or omit them.
KINDS:
- social: fill canonical_text and platform variant text.
- article (devto, hashnode, substack): fill article.title, subtitle, body_markdown, tags (at most four), canonical_url. For these destinations variant text is ""; the worker uses body_markdown. canonical_url is the source article URL on our blog.
- launch (producthunt): fill launch.name, tagline (at most 60 characters), description (at most 260), maker_comment. Product Hunt variant text is ""; the worker uses description. This is a manual launch kit.
Use null only for article or launch when absent. All other optional strings use "".
PLATFORMS: X at most 280 weighted characters (URL=23, emoji/CJK=2), Instagram at most 2200 characters and 30 hashtags, no caption URLs; LinkedIn at most 3000 characters.
CARDS: headline at most 70, keyword must occur in headline, stat at most 8, subline at most 110, accessible nonempty alt_text. Vary light/dark/mint templates.
Do not return settings, card.brand or validation_errors: the worker adds them.
Respond only with one JSON object matching this schema, no Markdown fences:\n${JSON.stringify(draftSchema)}`;
}

export function buildUserPrompt(input: any): string {
  const { source, platforms, count, templates, kinds } = input;
  const subject = source.type === "article" ? `Source article: ${source.url}` : `Topic: ${source.topic}\nHooks: ${(source.hooks ?? []).join(", ")}`;
  return `Create exactly ${count} drafts with distinct angles.\n${subject}\nTarget platforms: ${platforms.join(", ")}\nKinds: ${(kinds ?? ["social"]).join(", ")}\nPreferred templates: ${(templates ?? ["dark", "light", "mint"]).join(", ")}\nUse unique client_ref values. Fill the article or launch object for those kinds.`;
}
