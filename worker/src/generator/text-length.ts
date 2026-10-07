/**
 * How each platform counts the length of a post (amendment 04). A copy of
 * site/src/lib/social/text-length.ts: a change goes to both.
 *
 *  - X: weighted length, a link counts 23;
 *  - Bluesky: graphemes (`maxGraphemes: 300`); also 3,000 UTF-8 bytes;
 *  - Mastodon: code points, a link counts 23;
 *  - Farcaster: UTF-8 bytes (320 for a cast);
 *  - every other platform: code points.
 */

import { xWeightedLength } from "./x-length.js";

export const MASTODON_URL_LENGTH = 23;

const MASTODON_LINK = /\bhttps?:\/\/[^\s<>"]+/gi;
const TRAILING_PUNCT = /[.,;:!?)\]}'"»]+$/;

export function graphemeLength(text: string): number {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let n = 0;
    for (const _ of seg.segment(text)) n++;
    return n;
  }
  return Array.from(text).length;
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function codePointLength(text: string): number {
  return Array.from(text).length;
}

export function mastodonLength(text: string): number {
  const normalized = text.normalize("NFC");
  let total = 0;
  let cursor = 0;
  for (const m of normalized.matchAll(MASTODON_LINK)) {
    const link = m[0].replace(TRAILING_PUNCT, "");
    const start = m.index ?? 0;
    total += codePointLength(normalized.slice(cursor, start)) + MASTODON_URL_LENGTH;
    cursor = start + link.length;
  }
  return total + codePointLength(normalized.slice(cursor));
}

export function measurePlatformLength(platform: string, text: string): number {
  switch (platform) {
    case "x": return xWeightedLength(text);
    case "bluesky": return graphemeLength(text);
    case "mastodon": return mastodonLength(text);
    case "farcaster": return utf8Length(text);
    default: return codePointLength(text);
  }
}
