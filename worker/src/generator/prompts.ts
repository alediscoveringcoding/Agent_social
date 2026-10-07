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
- article (devto, hashnode, substack, medium, wordpress, listmonk): fill article.title, subtitle, body_markdown, tags (at most four; at most three of at most 25 characters each when medium is a target), canonical_url. For these destinations variant text is ""; the worker uses body_markdown. canonical_url is the source article URL on our blog. Medium needs a nonempty subtitle. For listmonk the title becomes the e-mail subject and the subtitle its one-line preview.
- article also covers linkedin-article (a native LinkedIn article or newsletter issue, title at most 100 characters), github (a release note or Discussion for our own repository, body at most 125000 characters, plain and factual) and press (a press release for a news outlet). Write a press release as: article.title, article.subtitle as the lead (one sentence with who, what, when), body_markdown with the facts and one quote-free body, ending with a short "Despre" paragraph about the brand. Variant text is "" for these too.
- launch (producthunt): fill launch.name, tagline (at most 60 characters), description (at most 260), maker_comment. Product Hunt variant text is ""; the worker uses description. This is a manual launch kit.
Use null only for article or launch when absent. All other optional strings use "".
PLATFORMS (social variants; the worker enforces these limits):
- x: at most 280 weighted characters (URL=23, emoji/CJK=2).
- instagram: at most 2200 characters and 30 hashtags, no caption URLs.
- facebook: long text is fine. linkedin-page (company page) and linkedin (personal profile): at most 3000 characters each.
- threads: at most 500 characters. bluesky: at most 300 graphemes (counted characters), URLs included. mastodon: at most 500 characters, every URL counts 23.
- reddit: variant.title (at most 300 characters) plus a body in text (at most 10000). pinterest: variant.title (at most 100) and text as the pin description (at most 500); variant.link is the destination URL.
- telegram: at most 4096 characters, but keep it under 1000 because an image turns the text into its caption. discord: at most 1980 characters, a short announcement.
- farcaster: at most 320 bytes of text (ASCII, so 320 characters). nostr: plain text, no markup. lemmy: variant.title (3 to 200 characters, one line) and a markdown body in text (at most 10000); variant.link is optional.
- slack: at most 40000 characters, a short team message. vk: at most 2048. mewe: plain text. moltbook: at most 300 characters. kick and twitch: a chat message of at most 500 characters, text only, no links needed.
- gmb (Google Business post): at most 1500 characters, about the business offer or help, one image at most.
- tumblr: a post of at most 32768 characters; variant.title optional, variant.link optional.
- dribbble: variant.title and a short description in text (the image is the card). skool and whop: variant.title and a community post in text (skool at most 5000 characters, whop at most 50000).
- tiktok: a photo post. variant.title at most 90 characters and a description in text of at most 2000. youtube is a video platform: write variant.title (at most 100 characters) and the video description (at most 5000) in text; a person adds the video.
- Manual channels (a person publishes them): quora is an answer to a question or a post in a Space (helpful first, at most 20000 characters, link only when it adds something). tradingview is an Idea: variant.title (at most 100) and a short market-neutral description (at most 10000), no price targets or advice. investing is a community post or comment on an instrument page (at most 5000). indiehackers: variant.title (at most 150) and a founder-style post (at most 20000). forum: a post of at most 20000 characters; variant.title only when it opens a new thread, "" for a reply. stackexchange: a factual answer or question body of 30 to 30000 characters; for a question variant.title (15 to 150 characters), otherwise ""; our brand is mentioned only when relevant and the text MUST disclose the affiliation plainly (for example "Sunt afiliat cu ${brand.name}"), as the site's self-promotion rules require.
VARIANT FIELDS: variant.title and variant.link are "" for every platform not named above. The worker adds subreddit, board, channel and community: never invent them.
CARDS: headline at most 70, keyword must occur in headline, stat at most 8, subline at most 110, accessible nonempty alt_text. Vary light/dark/mint templates.
Do not return settings, card.brand or validation_errors: the worker adds them.
Respond only with one JSON object matching this schema, no Markdown fences:\n${JSON.stringify(draftSchema)}`;
}

export function buildUserPrompt(input: any): string {
  const { source, platforms, count, templates, kinds } = input;
  const subject = source.type === "article" ? `Source article: ${source.url}` : `Topic: ${source.topic}\nHooks: ${(source.hooks ?? []).join(", ")}`;
  return `Create exactly ${count} drafts with distinct angles.\n${subject}\nTarget platforms: ${platforms.join(", ")}\nKinds: ${(kinds ?? ["social"]).join(", ")}\nPreferred templates: ${(templates ?? ["dark", "light", "mint"]).join(", ")}\nUse unique client_ref values. Fill the article or launch object for those kinds.`;
}
