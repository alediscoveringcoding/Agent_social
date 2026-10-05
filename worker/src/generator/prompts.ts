import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, "../../../prompts");

// Load facts.yaml
let facts: Record<string, unknown> = {};
try {
  facts = yaml.parse(fs.readFileSync(path.join(PROMPTS_DIR, "facts.yaml"), "utf-8"));
} catch {
  console.warn("facts.yaml not found");
}

// Load banned.txt
let banned: string[] = [];
try {
  banned = fs
    .readFileSync(path.join(PROMPTS_DIR, "banned.txt"), "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
} catch {
  console.warn("banned.txt not found");
}

// PRD section 5: the three seeded brands. The worker API sends only the slug
// (worker-api.openapi.yaml GenerationRequest.brand); the generator needs a
// display name too.
const BRAND_NAMES: Record<string, string> = {
  "taxes-support": "Taxes Support",
  "the-crypto-support": "The Crypto Support",
  "comets-of-web3": "Comets of Web3",
};

export function brandFromSlug(slug: string): { slug: string; name: string } {
  return { slug, name: BRAND_NAMES[slug] ?? slug };
}

export function buildSystemPrompt(brand: { slug: string; name: string }, input: any): string {
  return `You are a social media content creator for "${brand.name}", a Romanian crypto tax calculator.

VOICE:
- Romanian, using "tu" (informal, direct, calm)
- NO diacritics: never use a, i, s, t with cedilla or breve. Write "a" not "ă", "i" not "î", "s" not "ș", "t" not "ț"
- Reassuring, not alarmist. Explain, don't scare.
- No hype, no price predictions, no investment advice. This is a tax tool.
- Brand name exactly: "${brand.name}". Domains only inside URLs, never in running text.

BANNED PHRASES (never use):
${banned.map((b) => `- "${b}"`).join("\n")}

VERIFIED FACTS (use these, cite source "facts"):
${yaml.stringify(facts)}

FIGURES RULE:
- Every number, percentage, amount, date you include MUST be listed in the "figures" array.
- If it comes from the source article, mark source: "article".
- If it comes from the facts above, mark source: "facts".
- Anything else: source: "unverified" (this blocks approval until a human confirms).

OUTPUT FORMAT:
Respond with a JSON object containing a "drafts" array. Each draft follows this exact structure:
{
  "client_ref": "1",
  "kind": "social",
  "canonical_text": "the main text",
  "source_url": "url or null",
  "variants": [
    { "platform": "x", "text": "text for X (max 280 chars)", "settings": {} },
    { "platform": "facebook", "text": "text for Facebook", "settings": {} },
    { "platform": "instagram", "text": "text for Instagram (no URLs, needs image)", "settings": { "post_type": "post" } },
    { "platform": "linkedin-page", "text": "text for LinkedIn (max 3000 chars)", "settings": {} }
  ],
  "card": {
    "template": "dark|light|mint",
    "headline": "max 70 chars, no diacritics",
    "keyword": "one word from the headline to highlight",
    "stat": "optional, max 8 chars, e.g. '16%'",
    "subline": "max 110 chars, no diacritics",
    "brand": "${brand.slug}",
    "alt_text": "describe the card for screen readers"
  },
  "figures": [
    { "value": "16%", "context": "impozit pe castig", "source": "facts" }
  ],
  "validation_errors": [],
  "notes": "optional note for the reviewer"
}

PLATFORM RULES:
- X: max 280 chars (URLs count as 23 chars)
- Instagram: max 2200 chars, max 30 hashtags, NO URLs in caption, must have an image
- LinkedIn: max 3000 chars
- Facebook: image optional, link allowed
- dev.to: title + markdown body + max 4 tags + canonical URL + cover 1000x420
- Hashnode: title + subtitle + markdown + tags + canonical URL + cover 1600x840

CARD RULES:
- headline: max 70 chars
- keyword: must be a substring of headline
- stat: max 8 chars, optional (the single gold element on the card)
- subline: max 110 chars
- template: "dark", "light", or "mint" (vary across drafts)

RESPOND ONLY WITH VALID JSON. No markdown, no explanation, no preamble.`;
}

export function buildUserPrompt(input: any): string {
  const { source, platforms, count, templates } = input;

  if (source.type === "article") {
    return `Create ${count} social media post drafts for this article: ${source.url}

Target platforms: ${platforms.join(", ")}
Preferred card templates: ${(templates || ["dark", "light", "mint"]).join(", ")}

Each draft should present the article from a different angle or highlight a different key point. Vary the tone slightly across drafts while staying within the voice guidelines.`;
  }

  return `Create ${count} social media post drafts about: ${source.topic}

Hooks/angles to use: ${(source.hooks || []).join(", ")}
Target platforms: ${platforms.join(", ")}
Preferred card templates: ${(templates || ["dark", "light", "mint"]).join(", ")}

Each draft should present the topic from a different angle. Vary the tone slightly.`;
}
