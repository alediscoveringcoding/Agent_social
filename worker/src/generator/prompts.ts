import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "yaml";
import { draftSchema } from "./schema.js";
import { PLATFORMS, type Platform } from "../platforms.js";
import {
  EXAMPLE_GUARD, PROMPTS_DIR, loadPublicBrand, playbookKey, selectExamples, type BrandProfile, type StylePack,
} from "./style-pack.js";

// Ship these with the worker; missing policy files must fail visibly.
const read = (...p: string[]) => fs.readFileSync(path.join(PROMPTS_DIR, ...p), "utf8");
const facts = yaml.parse(read("facts.yaml"));
const banned = read("banned.txt").split("\n").map(s => s.trim()).filter(Boolean);
const universal = read("style", "universal.md").trim();
const contentTypes = read("style", "content-types.md").trim();
const selfCheck = read("style", "self-check.md").trim();

export function brandFromSlug(slug: string): { slug: string; name: string } {
  return { slug, name: loadPublicBrand(slug)?.name ?? slug };
}

const playbooks = new Map<string, string>();
function playbook(key: string): string {
  if (!playbooks.has(key)) {
    const file = path.join(PROMPTS_DIR, "style", "platforms", `${key}.md`);
    playbooks.set(key, fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "");
  }
  return playbooks.get(key)!;
}

const ARTICLE = 'article destination: fill article (see KINDS); variant text is "".';
/** Limits per platform (the worker enforces them). {brand} is replaced by the brand name. */
export const PLATFORM_RULES: Record<Platform, string> = {
  x: "at most 280 weighted characters (URL=23, emoji/CJK=2).",
  instagram: "at most 2200 characters and 30 hashtags, no caption URLs.",
  facebook: "long text is fine.",
  "linkedin-page": "company page, at most 3000 characters.",
  linkedin: "personal profile, at most 3000 characters.",
  threads: "at most 500 characters.",
  bluesky: "at most 300 graphemes (counted characters), URLs included.",
  mastodon: "at most 500 characters, every URL counts 23.",
  reddit: "variant.title (at most 300 characters) plus a body in text (at most 10000).",
  pinterest: "variant.title (at most 100) and text as the pin description (at most 500); variant.link is the destination URL.",
  telegram: "at most 4096 characters, but keep it under 1000 because an image turns the text into its caption.",
  discord: "at most 1980 characters, a short announcement.",
  farcaster: "at most 320 bytes of text (ASCII, so 320 characters).",
  nostr: "plain text, no markup.",
  lemmy: "variant.title (3 to 200 characters, one line) and a markdown body in text (at most 10000); variant.link is optional.",
  slack: "at most 40000 characters, a short team message.",
  vk: "at most 2048.",
  mewe: "plain text.",
  moltbook: "at most 300 characters.",
  kick: "a chat message of at most 500 characters, text only, no links needed.",
  twitch: "a chat message of at most 500 characters, text only, no links needed.",
  gmb: "Google Business post, at most 1500 characters, about the business offer or help, one image at most.",
  tumblr: "a post of at most 32768 characters; variant.title optional, variant.link optional.",
  dribbble: "variant.title and a short description in text (the image is the card).",
  skool: "variant.title and a community post in text (at most 5000 characters).",
  whop: "variant.title and a community post in text (at most 50000).",
  tiktok: "a photo post. variant.title at most 90 characters and a description in text of at most 2000.",
  youtube: "a video platform: write variant.title (at most 100 characters) and the video description (at most 5000) in text; a person adds the video.",
  quora: "manual: an answer to a question or a post in a Space (helpful first, at most 20000 characters, link only when it adds something).",
  tradingview: "manual: an Idea with variant.title (at most 100) and a short market-neutral description (at most 10000), no price targets or advice.",
  investing: "manual: a community post or comment on an instrument page (at most 5000).",
  indiehackers: "manual: variant.title (at most 150) and a founder-style post (at most 20000).",
  forum: 'manual: a post of at most 20000 characters; variant.title only when it opens a new thread, "" for a reply.',
  stackexchange: 'manual: a factual answer or question body of 30 to 30000 characters; for a question variant.title (15 to 150 characters), otherwise ""; our brand is mentioned only when relevant and the text MUST disclose the affiliation plainly (for example "Sunt afiliat cu {brand}"), as the site\'s self-promotion rules require.',
  devto: ARTICLE, hashnode: ARTICLE, substack: ARTICLE, medium: ARTICLE, wordpress: ARTICLE, listmonk: ARTICLE,
  "linkedin-article": 'article destination: a native LinkedIn article or newsletter issue, title at most 100 characters; variant text is "".',
  github: 'article destination: a release note or Discussion for our own repository, body at most 125000 characters, plain and factual; variant text is "".',
  press: 'article destination: a press release; variant text is "".',
  producthunt: 'launch destination: fill launch (see KINDS); variant text is "".',
};

const KINDS_SOCIAL = "- social: fill canonical_text and platform variant text.";
const KINDS_ARTICLE = `- article (devto, hashnode, substack, medium, wordpress, listmonk): fill article.title, subtitle, body_markdown, tags (at most four; at most three of at most 25 characters each when medium is a target), canonical_url. For these destinations variant text is ""; the worker uses body_markdown. canonical_url is the source article URL on our blog. Medium needs a nonempty subtitle. For listmonk the title becomes the e-mail subject and the subtitle its one-line preview.
- article also covers linkedin-article (a native LinkedIn article or newsletter issue, title at most 100 characters), github (a release note or Discussion for our own repository, body at most 125000 characters, plain and factual) and press (a press release for a news outlet). Write a press release as: article.title, article.subtitle as the lead (one sentence with who, what, when), body_markdown with the facts and one quote-free body, ending with a short "Despre" paragraph about the brand. Variant text is "" for these too.`;
const KINDS_LAUNCH = '- launch (producthunt): fill launch.name, tagline (at most 60 characters), description (at most 260), maker_comment. Product Hunt variant text is ""; the worker uses description. This is a manual launch kit.';

const LANG_NAME = { ro: "Romanian without diacritics", en: "English" } as const;
const DEFAULT_VOICE = 'Romanian without diacritics, informal "tu", direct, calm and reassuring. Never hype, price predictions or investment advice.';
const GENERIC_SUMMARY = "a Romanian crypto brand";

const lookup = <T,>(map: Record<string, T> | undefined, platform: string): T | undefined =>
  map?.[platform] ?? map?.[playbookKey(platform)];

function brandSection(b: BrandProfile, platforms: readonly string[]): string {
  const lines = [`VOICE:\n${(b.voice ?? DEFAULT_VOICE).trim()}`];
  const cta = platforms.map(p => [p, lookup(b.cta, p) ?? b.cta?.default] as const).filter(([, c]) => c !== undefined);
  if (cta.length) lines.push(`CTA per platform (text or an instruction):\n${cta.map(([p, c]) => `- ${p}: ${c === "" ? "(no CTA)" : c}`).join("\n")}`);
  const tags = platforms.map(p => [p, lookup(b.hashtags, p) ?? b.hashtags?.default] as const).filter(([, t]) => t && t.length);
  if (tags.length) lines.push(`Fixed hashtags (add 2-3 topical ones only where the platform uses hashtags):\n${tags.map(([p, t]) => `- ${p}: ${t!.join(" ")}`).join("\n")}`);
  if (b.bullet) lines.push(`List marker: ${b.bullet}`);
  if (b.emoji) lines.push(`Emoji: ${b.emoji === "none" ? "none" : b.emoji === "bullets-only" ? "only as list markers" : "light use"}.`);
  if (b.avoid?.length) lines.push(`Overused here, avoid: ${b.avoid.map(a => `"${a}"`).join(", ")}.`);
  if (b.disclaimer) lines.push(`When a post states a tax rate, add: ${b.disclaimer}`);
  return lines.join("\n");
}

function languageSection(b: BrandProfile, platforms: readonly string[]): string {
  const def = b.language?.default ?? "ro";
  const groups = new Map<string, string[]>();
  for (const p of platforms) {
    const l = lookup(b.language?.platforms, p) ?? def;
    groups.set(l, [...(groups.get(l) ?? []), p]);
  }
  const lines = [...groups].map(([l, ps]) => `- ${ps.join(", ")}: ${LANG_NAME[l as "ro" | "en"]}`);
  const card = b.language?.card ?? def;
  return `LANGUAGE:\n${lines.join("\n")}\n- canonical_text, article and launch fields: ${LANG_NAME[def]}\n- card text: ${LANG_NAME[card]}`;
}

const indent = (text: string) => text.split("\n").map(l => `  ${l}`).join("\n");

/**
 * Deterministic. Without `style` the prompt is generic: the public brand profile
 * and playbooks only. Without input.platforms every platform is described.
 */
export function buildSystemPrompt(brand: { slug: string; name: string }, input: any, style?: StylePack): string {
  const requested: string[] | undefined = Array.isArray(input?.platforms) && input.platforms.length ? input.platforms : undefined;
  const platforms = (requested ?? [...PLATFORMS]).filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p));
  const kinds: string[] | undefined = Array.isArray(input?.kinds) && input.kinds.length ? input.kinds : undefined;
  const pack: StylePack = style ?? { brand: loadPublicBrand(brand.slug), platformNotes: {}, examples: {} };
  const b: BrandProfile = pack.brand ?? {};
  const name = b.name ?? brand.name;

  const kindLines = [
    ...(!kinds || kinds.includes("social") ? [KINDS_SOCIAL] : []),
    ...(!kinds || kinds.includes("article") ? [KINDS_ARTICLE] : []),
    ...(!kinds || kinds.includes("launch") ? [KINDS_LAUNCH] : []),
  ];
  const platformLines = platforms.map(p => {
    const key = playbookKey(p);
    const parts = [`- ${p}: ${PLATFORM_RULES[p].replaceAll("{brand}", name)}`];
    if (playbook(key)) parts.push(indent(playbook(key)));
    if (pack.platformNotes[key]) parts.push(indent(`Brand notes:\n${pack.platformNotes[key]}`));
    return parts.join("\n");
  });
  const examples = selectExamples(pack, platforms);
  const exampleSection = examples.length
    ? `${EXAMPLE_GUARD}\n${examples.map(({ platform, example }) => `[${platform}${example.content_type ? `, ${example.content_type}` : ""}]\n${example.text}`).join("\n---\n")}`
    : "";

  const sections = [
    `Write for "${name}", ${b.summary ?? GENERIC_SUMMARY}.${b.audience ? `\nAudience: ${b.audience}` : ""}`,
    languageSection(b, platforms),
    `BRAND VOICE:\n${brandSection(b, platforms)}\nUse the exact brand name. Domains only inside http(s) URLs, never in running text.`,
    `UNIVERSAL WRITING RULES:\n${universal}`,
    `BANNED PHRASES:\n${banned.map(x => `- ${x}`).join("\n")}`,
    `VERIFIED FACTS (cite source "facts"):\n${yaml.stringify(facts)}`,
    `FIGURES: List every number, percentage, amount or date you use, including article, launch and card fields.
Keep verified facts as source "facts", numbers actually present in the source as "article", anything else as "unverified".
Do not invent facts from an article URL when no source contents are available. Mark unverifiable claims "unverified" or omit them.`,
    `KINDS:\n${kindLines.join("\n")}\nUse null only for article or launch when absent. All other optional strings use "".`,
    `CONTENT TYPES:\n${contentTypes}${b.content_types?.length ? `\nPreferred for this brand, in order: ${b.content_types.join(", ")}.` : ""}`,
    `PLATFORMS (social variants; the worker enforces these limits):\n${platformLines.join("\n")}\nVARIANT FIELDS: variant.title and variant.link are "" for every platform not named above. The worker adds subreddit, board, channel and community: never invent them.`,
    exampleSection,
    `CARDS: headline at most 70, keyword must occur in headline, stat at most 8, subline at most 110, accessible nonempty alt_text. Vary light/dark/mint templates.
Card craft: the headline is at most 8 words and uses the same entities and figure as the hook; keyword is the single accent (the winning entity or the number); the subline is the consequence, not a date or a source; use full institution names, no acronyms.
Do not return settings, card.brand or validation_errors: the worker adds them.`,
    `SELF-CHECK:\n${selfCheck}`,
    `Respond only with one JSON object matching this schema, no Markdown fences:\n${JSON.stringify(draftSchema)}`,
  ];
  return sections.filter(Boolean).join("\n");
}

export function buildUserPrompt(input: any): string {
  const { source, platforms, count, templates, kinds } = input;
  const subject = source.type === "article" ? `Source article: ${source.url}` : `Topic: ${source.topic}\nHooks: ${(source.hooks ?? []).join(", ")}`;
  return `Create exactly ${count} drafts with distinct angles. Give each draft a different content type when the source allows; prefer the brand's content_types.\n${subject}\nTarget platforms: ${platforms.join(", ")}\nKinds: ${(kinds ?? ["social"]).join(", ")}\nPreferred templates: ${(templates ?? ["dark", "light", "mint"]).join(", ")}\nUse unique client_ref values. Fill the article or launch object for those kinds.`;
}
