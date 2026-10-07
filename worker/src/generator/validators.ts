import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findBareDomains } from "./content-rules.js";
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
};
export const BLUESKY_MAX_BYTES = 3000;
export const REDDIT_TITLE_MAX = 300;
export const PINTEREST_TITLE_MAX = 100;
export const LEMMY_TITLE_MIN = 3;
export const LEMMY_TITLE_MAX = 200;
export const MEDIUM_MAX_TAGS = 3;
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
  const lower = text.toLowerCase();
  for (const phrase of bannedPhrases) {
    if (lower.includes(phrase)) {
      errors.push({
        rule: "banned_phrase",
        message: `Text contains banned phrase: "${phrase}"`,
      });
    }
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
  if (platform === "instagram" && /https?:\/\//.test(text)) {
    errors.push({
      rule: "instagram_no_urls",
      message: "Instagram captions should not contain URLs (they are not clickable)",
    });
  }

  if (platform === "instagram" && (text.match(/(?:^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length > 30) {
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
