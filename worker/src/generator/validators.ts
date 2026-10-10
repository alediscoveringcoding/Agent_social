import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findBannedPhrases, findBareDomains, findUrls, maskUrls } from "./content-rules.js";
import { measurePlatformLength, utf8Length } from "./text-length.js";
import { detectFigures } from "./figures.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, "../../../prompts");

// Load banned phrases
let bannedPhrases: string[] = [];
try {
  const raw = fs.readFileSync(path.join(PROMPTS_DIR, "banned.txt"), "utf-8");
  bannedPhrases = raw
    .split("\n")
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
} catch {
  console.warn("banned.txt not found, skipping banned phrase checks");
}

export interface ValidationError {
  rule: string;
  message: string;
  field?: string;
}

// Check for Romanian diacritics
const DIACRITICS = /[ăâîșşțţĂÂÎȘŞȚŢ]/;

/** Text limits per platform, in the unit measurePlatformLength counts (PRD section 5). */
export const LENGTH_LIMITS: Record<string, number> = {
  x: 280,
  producthunt: 260,
  facebook: 63206,
  "linkedin-page": 3000,
  instagram: 2200,
  threads: 500,
  bluesky: 300,
  mastodon: 500,
  linkedin: 3000,
  reddit: 10000,
  pinterest: 500,
  telegram: 4096,
  discord: 1980,
  medium: 100000,
  farcaster: 320,
  nostr: 100000,
  lemmy: 10000,
  slack: 40000,
  wordpress: 100000,
  vk: 2048,
  gmb: 1500,
  tumblr: 32768,
  dribbble: 40000,
  mewe: 63206,
  skool: 5000,
  whop: 50000,
  moltbook: 300,
  kick: 500,
  twitch: 500,
  tiktok: 2000,
  youtube: 5000,
  quora: 20000,
  "linkedin-article": 110000,
  tradingview: 10000,
  investing: 5000,
  indiehackers: 20000,
  stackexchange: 30000,
  github: 125000,
  forum: 20000,
  press: 50000,
};
export const TIKTOK_TITLE_MAX = 90;
export const YOUTUBE_TITLE_MAX = 100;
export const BLUESKY_MAX_BYTES = 3000;
export const REDDIT_TITLE_MAX = 300;
export const PINTEREST_TITLE_MAX = 100;
export const LEMMY_TITLE_MIN = 3;
export const LEMMY_TITLE_MAX = 200;
export const TRADINGVIEW_TITLE_MAX = 100;
export const INDIEHACKERS_TITLE_MAX = 150;
export const SE_TITLE_MIN = 15;
export const SE_TITLE_MAX = 150;
export const MEDIUM_MAX_TAGS = 3;
export const DEVTO_MAX_TAGS = 4;
export const HASHNODE_MAX_TAGS = 5;
export const PH_TAGLINE_MAX = 60;
export const MEDIUM_TAG_MAX = 25;

/** Titles and links the platforms need next to the text (reddit, pinterest, lemmy). */
export function validateVariantFields(platform: string, variant: { title?: string; link?: string }): ValidationError[] {
  const errors: ValidationError[] = [];
  const field = `variants.${platform}`;
  const title = (variant.title ?? "").trim();
  const link = (variant.link ?? "").trim();
  const chars = Array.from(title).length;
  const add = (rule: string, message: string) => errors.push({ rule, message, field });
  if (platform === "reddit") {
    if (!title) add("reddit_title", "Reddit needs a title");
    else if (chars > REDDIT_TITLE_MAX) add("reddit_title", `Reddit title exceeds ${REDDIT_TITLE_MAX} characters (got ${chars})`);
  }
  if (platform === "pinterest") {
    if (!title) add("pinterest_title", "Pinterest needs a title");
    else if (chars > PINTEREST_TITLE_MAX) add("pinterest_title", `Pinterest title exceeds ${PINTEREST_TITLE_MAX} characters (got ${chars})`);
  }
  if (platform === "lemmy") {
    if (!title) add("lemmy_title", "Lemmy needs a title");
    else if (chars < LEMMY_TITLE_MIN || chars > LEMMY_TITLE_MAX || /[\r\n]/.test(title)) {
      add("lemmy_title", `Lemmy title needs ${LEMMY_TITLE_MIN} to ${LEMMY_TITLE_MAX} characters on one line (got ${chars})`);
    }
  }
  // Dribbble and Skool refuse a post without a title; TikTok's is optional but capped; YouTube's is capped.
  if (platform === "dribbble" && !title) add("dribbble_title", "Dribbble needs a title");
  if (platform === "skool" && !title) add("skool_title", "Skool needs a title");
  if (platform === "tiktok" && chars > TIKTOK_TITLE_MAX) add("tiktok_title", `TikTok title exceeds ${TIKTOK_TITLE_MAX} characters (got ${chars})`);
  if (platform === "youtube") {
    if (!title) add("youtube_title", "YouTube needs a title");
    else if (chars > YOUTUBE_TITLE_MAX) add("youtube_title", `YouTube title exceeds ${YOUTUBE_TITLE_MAX} characters (got ${chars})`);
  }
  // Amendment 05 (manual channels): TradingView and Indie Hackers refuse a post without a title; a Stack Exchange
  // title (a question) is 15 to 150 characters. Forum: a title opens a new thread, none means a reply.
  if (platform === "tradingview") {
    if (!title) add("tradingview_title", "TradingView needs a title");
    else if (chars > TRADINGVIEW_TITLE_MAX) add("tradingview_title", `TradingView title exceeds ${TRADINGVIEW_TITLE_MAX} characters (got ${chars})`);
  }
  if (platform === "indiehackers") {
    if (!title) add("indiehackers_title", "Indie Hackers needs a title");
    else if (chars > INDIEHACKERS_TITLE_MAX) add("indiehackers_title", `Indie Hackers title exceeds ${INDIEHACKERS_TITLE_MAX} characters (got ${chars})`);
  }
  if (platform === "stackexchange" && title && (chars < SE_TITLE_MIN || chars > SE_TITLE_MAX)) {
    add("stackexchange_title", `Stack Exchange title needs ${SE_TITLE_MIN} to ${SE_TITLE_MAX} characters (got ${chars})`);
  }
  return errors;
}

export function validateContent(text: string, platform: string): ValidationError[] {
  const errors: ValidationError[] = [];

  // Diacritics check
  if (DIACRITICS.test(text)) {
    const match = text.match(DIACRITICS);
    errors.push({
      rule: "no_diacritics",
      message: `Text contains diacritics: "${match?.[0]}"`,
    });
  }

  // Banned phrases
  for (const phrase of findBannedPhrases(text, bannedPhrases)) {
    errors.push({
      rule: "banned_phrase",
      message: `Text contains banned phrase: "${phrase}"`,
    });
  }

  // Bare domain check (domain outside of a URL)
  if (findBareDomains(text).length > 0) {
    errors.push({
      rule: "bare_domain",
      message: "Domain appears outside of a URL",
    });
  }

  // Platform-specific length limits (the same as the site's PLATFORM_MAX_LENGTH)
  const length = measurePlatformLength(platform, text);
  if (LENGTH_LIMITS[platform] && length > LENGTH_LIMITS[platform]) {
    errors.push({
      rule: "length",
      message: `Text exceeds ${platform} limit of ${LENGTH_LIMITS[platform]} ${platform === "farcaster" ? "bytes" : "chars"} (got ${length})`,
    });
  }
  if (platform === "bluesky" && utf8Length(text) > BLUESKY_MAX_BYTES) {
    errors.push({ rule: "length_bytes", message: `Text exceeds bluesky limit of ${BLUESKY_MAX_BYTES} bytes (got ${utf8Length(text)})` });
  }

  // Instagram: no URLs in caption
  if (platform === "instagram" && findUrls(text).length > 0) {
    errors.push({
      rule: "instagram_no_urls",
      message: "Instagram captions should not contain URLs (they are not clickable)",
    });
  }

  if (platform === "instagram" && (maskUrls(text).match(/(?:^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length > 30) {
    errors.push({ rule: "instagram_hashtags", message: "Instagram allows at most 30 hashtags" });
  }

  return errors;
}

// Extract figures from text for the figures array
export function extractFigures(
  text: string,
): Array<{ value: string; context: string; source: string }> {
  const figures: Array<{ value: string; context: string; source: string }> = [];
  for (const match of detectFigures(text)) {
    if (match.kind === "number" && match.value.length <= 1) continue;
    figures.push({ value: match.value, context: text.slice(Math.max(0, match.index - 20), match.index + match.value.length + 20).trim(), source: "unverified" });
  }
  return figures;
}
