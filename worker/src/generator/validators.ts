import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { findBareDomains } from "./content-rules.js";
import { xWeightedLength } from "./x-length.js";
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

  // Platform-specific length limits
  const limits: Record<string, number> = {
    x: 280,
    facebook: 63206,
    "linkedin-page": 3000,
    instagram: 2200,
  };
  const length = platform === "x" ? xWeightedLength(text) : Array.from(text).length;
  if (limits[platform] && length > limits[platform]) {
    errors.push({
      rule: "length",
      message: `Text exceeds ${platform} limit of ${limits[platform]} chars (got ${length})`,
    });
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
