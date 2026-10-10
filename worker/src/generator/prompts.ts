import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "yaml";
import { draftSchema } from "./schema.js";
import { wantsResearch, type ResearchBrief } from "./research-types.js";
import { PLATFORMS, type Platform } from "../platforms.js";
import {
  EXAMPLE_GUARD, PROMPTS_DIR, PROMPT_TIME_ZONE, loadContentTypes, loadPublicBrand, packEntry, packKey, playbookKey, selectExamples, splitNews,
  targetsLinkedin, todayOf, type BrandProfile, type StylePack,
} from "./style-pack.js";

// Ship these with the worker; missing policy files must fail visibly.
const read = (...p: string[]) => fs.readFileSync(path.join(PROMPTS_DIR, ...p), "utf8");
const facts = yaml.parse(read("facts.yaml"));
const banned = read("banned.txt").split("\n").map(s => s.trim()).filter(Boolean);
const universal = read("style", "universal.md").trim();
const { base: contentTypes, news: newsContentTypes } = loadContentTypes();
const newsParts = splitNews(newsContentTypes);
const selfCheck = read("style", "self-check.md").trim();

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A validity date of facts.yaml as YYYY-MM-DD; a malformed one fails visibly, because it decides what the writer may state. */
function factDay(value: unknown, field: string, item: object): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const day = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).trim();
  if (!DAY.test(day)) throw new Error(`prompts/facts.yaml: ${field} must be YYYY-MM-DD, got "${String(value)}" in ${JSON.stringify(item)}`);
  return day;
}

/**
 * The facts that hold on `today` (YYYY-MM-DD, Europe/Bucharest): a fact is dropped when its
 * valid_to is before today or its valid_from is after today. Facts without dates are kept,
 * and so is a fact on the last day of its range. Groups left empty are dropped.
 */
export function activeFacts(all: unknown, today: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!all || typeof all !== "object") return out;
  for (const [group, items] of Object.entries(all as Record<string, unknown>)) {
    if (!Array.isArray(items)) { out[group] = items; continue; }
    const kept = items.filter(item => {
      if (!item || typeof item !== "object") return true;
      const from = factDay((item as any).valid_from, "valid_from", item);
      const to = factDay((item as any).valid_to, "valid_to", item);
      return !(from !== undefined && from > today) && !(to !== undefined && to < today);
    });
    if (kept.length) out[group] = kept;
  }
  return out;
}

export function brandFromSlug(slug: string): { slug: string; name: string } {
  return { slug, name: loadPublicBrand(slug)?.name ?? slug };
}

const playbooks = new Map<string, string>();
function playbookFile(key: string): string {
  if (!playbooks.has(key)) {
    const file = path.join(PROMPTS_DIR, "style", "platforms", `${key}.md`);
    playbooks.set(key, fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "");
  }
  return playbooks.get(key)!;
}
/** The public playbook of a platform: its own file first, then its playbook key's (linkedin-page uses linkedin). */
const playbook = (platform: string): string => playbookFile(platform) || playbookFile(playbookKey(platform));

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
const KINDS_ARTICLE = `- article (devto, hashnode, substack, medium, wordpress, listmonk): fill article.title, subtitle, body_markdown, tags (at most four; at most three of at most 25 characters each when medium is a target), canonical_url. For these destinations variant text is ""; the worker uses body_markdown. canonical_url is the request's article URL on our blog, copied exactly as given, or "" when the request has no article URL; never a URL from the research brief or from memory. devto, hashnode and medium require that canonical_url, which only an article request supplies: when the request's source is not an article, write no variant for them and say in notes that they were left out. Medium needs a nonempty subtitle. For listmonk the title becomes the e-mail subject and the subtitle its one-line preview.
- article also covers linkedin-article (a native LinkedIn article or newsletter issue, title at most 100 characters), github (a release note or Discussion for our own repository, body at most 125000 characters, plain and factual) and press (a press release for a news outlet). Write a press release as: article.title, article.subtitle as the lead (one sentence with who, what, when), body_markdown with the facts and one quote-free body, ending with a short "Despre" paragraph about the brand. Variant text is "" for these too.`;
const KINDS_LAUNCH = '- launch (producthunt): fill launch.name, tagline (at most 60 characters), description (at most 260), maker_comment. Product Hunt variant text is ""; the worker uses description. This is a manual launch kit.';

const LANG_NAME = { ro: "Romanian without diacritics", en: "English" } as const;
/** Platforms whose playbook says "no CTA line": the brand's CTA never applies to them. */
const NO_CTA = new Set(["threads"]);
/** Platforms whose playbook asks for the link in the post text (one URL, see linksSection). */
export const LINK_IN_TEXT = ["x", "facebook", "telegram", "bluesky"] as const;
/** Article destinations that need article.canonical_url, which only an article request can supply. */
export const NEEDS_CANONICAL = ["devto", "hashnode", "medium"] as const;
const DEFAULT_VOICE ='Romanian without diacritics, informal "tu", direct, calm and reassuring. Never hype, price predictions or investment advice.';
const GENERIC_SUMMARY = "a Romanian crypto brand";

const lookup = packEntry;

function brandSection(b: BrandProfile, platforms: readonly string[]): string {
  const lines = [`VOICE:\n${(b.voice ?? DEFAULT_VOICE).trim()}`];
  const cta = platforms.map(p => [p, NO_CTA.has(playbookKey(p)) ? "" : lookup(b.cta, p) ?? b.cta?.default] as const).filter(([, c]) => c !== undefined);
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
 * The owner's original briefs for the targeted platforms only, one section per brief. A platform
 * uses its own original first and its playbook's second, so linkedin and linkedin-page share
 * original/linkedin.md unless the pack also has original/linkedin-page.md.
 */
function originalSections(pack: StylePack, platforms: readonly string[]): string[] {
  const groups = new Map<string, string[]>();
  for (const p of platforms) {
    const key = packKey(pack.originals, p);
    if (key !== undefined && pack.originals[key]) groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups].map(([key, ps]) => {
    const targeted = ps.join(", ");
    return `OWNER'S ORIGINAL BRIEF FOR ${targeted} (authoritative for voice, selection and structure; the schema and content rules above win on conflicts):\n${pack.originals[key]}\n(end of the owner's brief for ${targeted})`;
  });
}

/**
 * The News section of content-types.md, cut to the request. The story types and the audit are
 * for source.type "news" only; the hook shapes serve any request with research; the LinkedIn
 * parts (the "taggable entities" criterion and the post structure) need a LinkedIn target.
 */
function newsSection(input: any, platforms: readonly string[]): string {
  if (!wantsResearch(input) || !newsContentTypes) return "";
  const linkedin = targetsLinkedin(platforms);
  const isNews = input?.source?.type === "news";
  const parts = [
    isNews ? [newsParts.audit, linkedin ? newsParts.linkedinCriterion : ""].filter(Boolean).join("\n")
      : "## Posts from a research brief\nOne draft is one story or angle from the brief. There is no story audit: use what the brief supports and shape each draft with the hooks below.",
    newsParts.hooks,
    linkedin ? newsParts.linkedinPost : "",
  ].filter(Boolean);
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}

const linkList = (platforms: readonly string[]) => LINK_IN_TEXT.filter(p => platforms.includes(p));

/**
 * One link rule for every platform. Only the platforms whose playbook asks for the link in the
 * text carry a URL there, and it is the request's article URL or a source URL of the research
 * brief, never any other.
 */
function linksSection(platforms: readonly string[]): string {
  const linked = linkList(platforms);
  return `LINKS (one rule for every platform):
- ${linked.length ? `The text of ${linked.join(", ")} may contain one URL, placed as that platform's playbook says: exactly one when the request offers a link, none otherwise.` : "No targeted platform carries a URL in its text."}
- The URL is the request's article URL, exactly as given, when the request is an article request. For a request with a research brief it is the most relevant source URL from the brief's SOURCES list, copied exactly. It is never any other URL and never one from memory.
- Every other platform, LinkedIn and Instagram included, has no URL in its text. Sources for LinkedIn are cited in sources and posted by a person as the first comment.
- variant.link and article.canonical_url are separate fields: variant.link is "" unless the platform rules name a link field, and then it holds the same kind of URL; article.canonical_url follows KINDS.`;
}

/**
 * Deterministic. Without `style` the prompt is generic: the public brand profile
 * and playbooks only. Without input.platforms every platform is described.
 */
export function buildSystemPrompt(brand: { slug: string; name: string }, input: any, style?: StylePack): string {
  const requested: string[] | undefined = Array.isArray(input?.platforms) && input.platforms.length ? input.platforms : undefined;
  const platforms = (requested ?? [...PLATFORMS]).filter((p): p is Platform => (PLATFORMS as readonly string[]).includes(p));
  const kinds: string[] | undefined = Array.isArray(input?.kinds) && input.kinds.length ? input.kinds : undefined;
  const pack: StylePack = style ?? { brand: loadPublicBrand(brand.slug), platformNotes: {}, examples: {}, originals: {} };
  const news = newsSection(input, platforms);
  const today = todayOf(input);
  const active = activeFacts(facts, today);
  const b: BrandProfile = pack.brand ?? {};
  const name = b.name ?? brand.name;

  const kindLines = [
    ...(!kinds || kinds.includes("social") ? [KINDS_SOCIAL] : []),
    ...(!kinds || kinds.includes("article") ? [KINDS_ARTICLE] : []),
    ...(!kinds || kinds.includes("launch") ? [KINDS_LAUNCH] : []),
  ];
  const platformLines = platforms.map(p => {
    const parts = [`- ${p}: ${PLATFORM_RULES[p].replaceAll("{brand}", name)}`];
    if (playbook(p)) parts.push(indent(playbook(p)));
    const notes = packEntry(pack.platformNotes, p);
    if (notes) parts.push(indent(`Brand notes:\n${notes}`));
    return parts.join("\n");
  });
  const examples = selectExamples(pack, platforms);
  const exampleSection = examples.length
    ? `${EXAMPLE_GUARD}\n${examples.map(({ platform, example }) => `[${platform}${example.content_type ? `, ${example.content_type}` : ""}]\n${example.text}`).join("\n---\n")}`
    : "";

  const sections = [
    `Write for "${name}", ${(b.summary ?? GENERIC_SUMMARY).trim().replace(/\.$/, "")}.${b.audience ? `\nAudience: ${b.audience}` : ""}`,
    languageSection(b, platforms),
    `BRAND VOICE:\n${brandSection(b, platforms)}\nUse the exact brand name. Domains only inside http(s) URLs, never in running text.`,
    `UNIVERSAL WRITING RULES:\n${universal}`,
    `BANNED PHRASES:\n${banned.map(x => `- ${x}`).join("\n")}`,
    `VERIFIED FACTS (cite source "facts"). Today is ${today} (${PROMPT_TIME_ZONE}). Facts that stopped being valid before today are left out. When no fact below covers a rate, threshold or deadline you need, do not state one from memory.\n${Object.keys(active).length ? yaml.stringify(active, { lineWidth: 0 }) : "(none valid today)\n"}`,
    `FIGURES: List every number, percentage, amount or date you use, including article, launch and card fields.
Keep verified facts as source "facts", numbers actually present in the source as "article", anything else as "unverified".
Do not invent facts from an article URL when no source contents are available. Mark unverifiable claims "unverified" or omit them.`,
    `KINDS:\n${kindLines.join("\n")}\nUse null only for article or launch when absent. All other optional strings use "".`,
    `CONTENT TYPES:\n${contentTypes}${b.content_types?.length ? `\nPreferred for this brand, in order: ${b.content_types.join(", ")}.` : ""}${news}`,
    `PLATFORMS (social variants; the worker enforces these limits):\n${platformLines.join("\n")}\nVARIANT FIELDS: variant.title and variant.link are "" for every platform not named above. The worker adds subreddit, board, channel and community: never invent them.`,
    ...originalSections(pack, platforms),
    exampleSection,
    linksSection(platforms),
    `CARDS: headline at most 70, keyword must occur in headline, stat at most 8, subline at most 110, accessible nonempty alt_text. Vary light/dark/mint templates.
Card craft: the headline is at most 8 words and uses the same entities and figure as the hook; keyword is the single accent (the winning entity or the number); the subline is the consequence, not a date or a source; use full institution names, no acronyms.
Do not return settings, card.brand or validation_errors: the worker adds them.`,
    `SELF-CHECK:\n${selfCheck}`,
    `Respond only with one JSON object matching this schema, no Markdown fences:\n${JSON.stringify(draftSchema)}`,
  ];
  return sections.filter(Boolean).join("\n");
}

const SOURCE_RULES = `SOURCE RULES:
- Use only facts from the brief above and the verified facts; add nothing from memory.
- Each draft's sources lists the ids it relies on, each with a note of what it supports. Cite only ids listed above; never invent an id, a source or a URL.
- Every figure taken from the brief goes in figures with its source_id and the source "unverified"; a person checks the links before approval.
- Links follow LINKS in the system prompt: on x, facebook, telegram and bluesky the text may carry one URL, the most relevant source URL from the SOURCES list above (for an article request, the article URL), copied exactly. Never any other URL in post text, and none on any other platform. Everywhere else sources are cited by id only.
- Prefer facts that come from primary sources (the regulator, the company's own release) over reports about them. Where a fact rests on a secondary source only, or the brief lists it as unverified, say so in notes or leave it out.
- Give explicit absolute dates, as the brief has them; if the brief gives no date for an event, leave the date out.`;

function sourceLine(s: ResearchBrief["sources"][number]): string {
  const meta = [s.publisher, s.published_at].filter(Boolean).join(", ");
  return `${s.id}: ${s.title}${meta ? ` (${meta})` : ""} ${s.url}`.trim();
}

/** The research brief and the source rules, or the plain notice that a news request has none. */
function briefSection(source: any, research?: ResearchBrief): string {
  if (!research) {
    return source?.type === "news"
      ? "\n\nNO RESEARCH BRIEF: this request asks for recent news, but the worker supplied no research brief (a fault, not a choice). Do not write news from memory and do not invent stories, facts, dates, sources or URLs. Write only from the verified facts, leave sources empty, and say in notes of every draft that the research brief was missing."
      : "";
  }
  const list = research.sources.length
    ? `SOURCES (cite only these ids; the worker turns each id into its link):\n${research.sources.map(sourceLine).join("\n")}`
    : "SOURCES: the search returned none. Cite nothing, write only from the verified facts and say so in notes.";
  return `\n\nRESEARCH BRIEF (notes from a web search; each fact is followed by the [S#] ids of the sources that support it):\n${research.text.trim()}\n\n${list}\n\n${SOURCE_RULES}`;
}

export function buildUserPrompt(input: any, research?: ResearchBrief): string {
  const { source, platforms, count, templates, kinds } = input;
  const news = source.type === "news";
  const article = source.type === "article";
  const subject = article ? `Source article: ${source.url}\nUse exactly this URL as article.canonical_url and, where LINKS allows a link in the text, as its one URL.`
    : news ? `Recent news, from the research brief below${source.topic ? `; focus: ${source.topic}` : ""}`
    : `Topic: ${source.topic}\nHooks: ${(source.hooks ?? []).join(", ")}`;
  // With a research brief the number of stories decides, not the request: count is a ceiling.
  const task = research
    ? `Create up to ${count} drafts, one per story or angle from the research brief${news ? ", strongest first" : ""}. Each draft covers a different story or angle${news ? " and uses the hook shape that fits it (duel or before/after)" : "; give each a different content type when the brief allows and prefer the brand's content_types"}. If fewer than ${count} qualify, write fewer drafts and say why in notes.`
    : `Create exactly ${count} drafts with distinct angles. Give each draft a different content type when the source allows; prefer the brand's content_types.`;
  // devto, hashnode and medium need article.canonical_url, which only an article request supplies.
  const noCanonical = article ? [] : (platforms as string[]).filter(p => (NEEDS_CANONICAL as readonly string[]).includes(p));
  const leaveOut = noCanonical.length
    ? `\nLeave out ${noCanonical.join(", ")}: each needs an article URL for canonical_url, and this request has none. Write no variant for ${noCanonical.length > 1 ? "them" : "it"} and say in notes that ${noCanonical.length > 1 ? "they were" : "it was"} left out.`
    : "";
  return `${task}\n${subject}\nTarget platforms: ${platforms.join(", ")}${leaveOut}\nKinds: ${(kinds ?? ["social"]).join(", ")}\nPreferred templates: ${(templates ?? ["dark", "light", "mint"]).join(", ")}\nUse unique client_ref values. Fill the article or launch object for those kinds.${briefSection(source, research)}`;
}
