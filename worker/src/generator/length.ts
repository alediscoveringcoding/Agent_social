import { kindOf } from "../platforms.js";
import { measurePlatformLength } from "./text-length.js";
import { LENGTH_LIMITS, type ValidationError } from "./validators.js";

/**
 * Post length (amendment 10), picked per request: the site's POST_LENGTHS. One target for
 * canonical_text and every social variant, the same on every platform; a platform whose
 * limit is lower fills most of it instead. Article and launch fields keep their own rules.
 */
export const POST_LENGTHS = ["short", "long"] as const;
export type PostLength = (typeof POST_LENGTHS)[number];

/** Characters, in each platform's own unit (measurePlatformLength). */
export const LENGTH_TARGETS: Record<PostLength, { min: number; max: number; words: string }> = {
  short: { min: 250, max: 600, words: "about 40 to 100 words" },
  long: { min: 1200, max: 2000, words: "about 200 to 330 words" },
};

/** With a card or an image the text is a caption: Telegram takes 1,024 characters (the site's TELEGRAM_CAPTION_MAX). */
const CAPTION_LIMITS: Record<string, number> = { telegram: 1024 };
/** On a platform whose limit is below the target, a long text fills at least this share of it, a short one this share. */
const LONG_SHARE = 0.7;
const SHORT_SHARE = 0.4;
/** A text this far over its target's max is out of form; going over a platform's hard limit is the `length` rule. */
export const OVER_TARGET = 1.25;

/** Drafts per AI call: long drafts are about three times bigger, so a request is written in batches. */
export const DRAFTS_PER_CALL: Record<PostLength, number> = { short: 8, long: 3 };

/** A request without the field (one made before amendment 10) is long. */
export function postLengthOf(input: any): PostLength {
  return input?.length === "short" ? "short" : "long";
}

const limitOf = (platform: string): number => CAPTION_LIMITS[platform] ?? LENGTH_LIMITS[platform] ?? Infinity;

/** The target of a platform's text, or null when its text is not a social post (article and launch destinations). */
export function lengthTarget(platform: string, length: PostLength): { min: number; max: number } | null {
  if (kindOf(platform) !== "social") return null;
  const { min, max } = LENGTH_TARGETS[length];
  const limit = limitOf(platform);
  if (limit >= max) return { min, max };
  return length === "long"
    ? { min: Math.floor(limit * LONG_SHARE), max: limit }
    : { min: Math.min(min, Math.floor(limit * SHORT_SHARE)), max: Math.min(max, limit) };
}

/** The request's draft count in batches of at most DRAFTS_PER_CALL, as even as possible (5 long: 3 and 2). */
export function draftBatches(count: number, length: PostLength): number[] {
  const total = Math.max(1, Math.floor(Number(count) || 1));
  const calls = Math.ceil(total / DRAFTS_PER_CALL[length]);
  return Array.from({ length: calls }, (_, i) => Math.floor(total / calls) + (i < total % calls ? 1 : 0));
}

function check(n: number, target: { min: number; max: number }, length: PostLength, what: string, limit: number): ValidationError[] {
  const form = length === "long" ? "Long" : "Short";
  if (n < target.min) {
    return [{ rule: "too_short", message: `${form} form: ${what} has ${n} characters; it needs ${target.min} to ${target.max}. Develop it with the context, the figures from the facts or the brief and what it means for the reader; do not pad or repeat.` }];
  }
  if (n > Math.round(target.max * OVER_TARGET) && n <= limit) {
    return [{ rule: "too_long_for_form", message: `${form} form: ${what} has ${n} characters; keep it within ${target.min} to ${target.max}.` }];
  }
  return [];
}

/** The chosen length for one variant's text. An empty text is EMPTY_TEXT, not this rule. */
export function validateLength(text: string, platform: string, length: PostLength): ValidationError[] {
  const target = lengthTarget(platform, length);
  if (!target || !text.trim()) return [];
  return check(measurePlatformLength(platform, text), target, length, `the ${platform} text`, limitOf(platform));
}

/** The chosen length for canonical_text, the master text the variants come from. */
export function validateCanonicalLength(text: string, length: PostLength): ValidationError[] {
  if (!text.trim()) return [];
  return check(Array.from(text).length, LENGTH_TARGETS[length], length, "canonical_text", Infinity);
}
