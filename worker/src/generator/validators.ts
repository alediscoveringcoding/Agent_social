import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
  const bareDomainRe = /(?<!\/)(?:taxes\.support|thecrypto\.support)(?!\/)/g;
  if (bareDomainRe.test(text)) {
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
  if (limits[platform] && text.length > limits[platform]) {
    errors.push({
      rule: "length",
      message: `Text exceeds ${platform} limit of ${limits[platform]} chars (got ${text.length})`,
    });
  }

  // Instagram: no URLs in caption
  if (platform === "instagram" && /https?:\/\//.test(text)) {
    errors.push({
      rule: "instagram_no_urls",
      message: "Instagram captions should not contain URLs (they are not clickable)",
    });
  }

  // Figures detection
  const figuresRe = /\d+|%|lei|RON|EUR/i;
  if (figuresRe.test(text)) {
    // Flag: this post contains figures and needs manual verification
    errors.push({
      rule: "contains_figures",
      message: "Post contains figures that need manual verification",
    });
  }

  return errors;
}

// Extract figures from text for the figures array
export function extractFigures(
  text: string,
): Array<{ value: string; context: string; source: string }> {
  const figures: Array<{ value: string; context: string; source: string }> = [];
  // Match percentages, amounts with lei/RON/EUR, dates
  const patterns = [
    /(\d+(?:\.\d+)?%)/g,
    /(\d+(?:\.\d+)?\s*(?:lei|RON|EUR))/gi,
    /(\d{1,2}\s+(?:ianuarie|februarie|martie|aprilie|mai|iunie|iulie|august|septembrie|octombrie|noiembrie|decembrie)(?:\s+\d{4})?)/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[1];
      // Get surrounding context (20 chars each side)
      const start = Math.max(0, match.index - 20);
      const end = Math.min(text.length, match.index + match[0].length + 20);
      const context = text.slice(start, end).trim();
      figures.push({ value, context, source: "unverified" });
    }
  }
  return figures;
}
