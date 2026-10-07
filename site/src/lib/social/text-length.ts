/**
 * How each platform counts the length of a post (amendment 04). Pure and
 * browser-safe; the worker keeps a copy (worker/src/generator/text-length.ts),
 * so a change goes to both.
 *
 *  - X: weighted length, a link counts 23 (x-length.ts, PRD section 5);
 *  - Bluesky: graphemes (the lexicon's `maxGraphemes: 300`); the same text is
 *    also limited to 3,000 UTF-8 bytes (`maxLength`), see utf8Length;
 *  - Mastodon: code points, a link counts 23 (`characters_reserved_per_url`
 *    of the instance configuration; 23 is the default). Counting code points
 *    rather than graphemes is the stricter reading, so it never lets
 *    through a post the server would refuse;
 *  - Farcaster: UTF-8 bytes (a cast holds 320 bytes, 1,024 for a long cast);
 *  - every other platform: code points.
 */

import { xWeightedLength } from './x-length.ts'

export const MASTODON_URL_LENGTH = 23

const MASTODON_LINK = /\bhttps?:\/\/[^\s<>"]+/gi
const TRAILING_PUNCT = /[.,;:!?)\]}'"»]+$/

/** Grapheme clusters, as Bluesky counts them. */
export function graphemeLength(text: string): number {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    let n = 0
    for (const _ of seg.segment(text)) n++
    return n
  }
  return Array.from(text).length
}

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length
}

export function codePointLength(text: string): number {
  return Array.from(text).length
}

/** Code points, with every http(s) link counted as 23. */
export function mastodonLength(text: string): number {
  const normalized = text.normalize('NFC')
  let total = 0
  let cursor = 0
  for (const m of normalized.matchAll(MASTODON_LINK)) {
    const link = m[0].replace(TRAILING_PUNCT, '')
    const start = m.index ?? 0
    total += codePointLength(normalized.slice(cursor, start)) + MASTODON_URL_LENGTH
    cursor = start + link.length
  }
  return total + codePointLength(normalized.slice(cursor))
}

/** The length the platform enforces, in the unit its limit is written in. */
export function measurePlatformLength(platform: string, text: string): number {
  switch (platform) {
    case 'x':
      return xWeightedLength(text)
    case 'bluesky':
      return graphemeLength(text)
    case 'mastodon':
      return mastodonLength(text)
    case 'farcaster':
      return utf8Length(text)
    default:
      return codePointLength(text)
  }
}

/** The unit of `measurePlatformLength`, for messages ("din 300 grafeme"). */
export function lengthUnit(platform: string): string {
  switch (platform) {
    case 'bluesky':
      return 'grafeme'
    case 'farcaster':
      return 'octeti'
    default:
      return 'caractere'
  }
}
