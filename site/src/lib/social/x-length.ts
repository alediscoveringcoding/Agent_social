/**
 * X's weighted length (PRD section 5: "≤ 280 weighted chars, URL = 23").
 *
 * The rules of twitter-text v3, reimplemented without the library:
 *  - the text is NFC-normalized first;
 *  - every link counts as 23, whatever its length (X wraps it in t.co);
 *  - an emoji counts as 2, however many code points it is made of
 *    (skin tones, ZWJ families, flags);
 *  - any other code point counts 1 inside these ranges and 2 outside them:
 *    U+0000–U+10FF, U+2000–U+200D, U+2010–U+201F, U+2032–U+2037.
 *    So Latin text (Romanian included) is 1 per character, CJK is 2.
 *
 * Links: explicit http(s):// and www. links, plus bare domains with a common
 * TLD ("example.com/x"), which X also turns into links. Pure, browser-safe.
 */

export const X_MAX_WEIGHTED_LENGTH = 280
export const X_URL_LENGTH = 23

const WEIGHT_1_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
]

const COMMON_TLDS =
  'com|net|org|ro|io|support|co|dev|app|eu|info|me|ly|gg|xyz|ai|uk|de|fr|it|es|nl|be|ch|at|us|ca|tv|to|so|sh|page|blog|news|tech|online|site'

const LINK_RE = new RegExp(
  [
    '\\bhttps?:\\/\\/[^\\s<>"]+',
    '\\bwww\\.[^\\s<>"]+',
    `(?<![\\w@.-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${COMMON_TLDS})\\b(?:\\/[^\\s<>"]*)?`,
  ].join('|'),
  'gi'
)

const TRAILING_PUNCT = /[.,;:!?)\]}'"»]+$/

function codePointWeight(cp: number): number {
  for (const [lo, hi] of WEIGHT_1_RANGES) {
    if (cp >= lo && cp <= hi) return 1
  }
  return 2
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u

function isEmojiGrapheme(g: string): boolean {
  if (REGIONAL_INDICATOR.test(g)) return true
  if (g.includes('⃣')) return true // keycap: 1️⃣
  if (!PICTOGRAPHIC.test(g)) return false
  // ©, ® and the like are pictographic but plain text unless asked to be emoji
  // (VS16) - X counts them like the letters around them.
  for (const ch of g) {
    const cp = ch.codePointAt(0) ?? 0
    if (cp >= 0x2000 && PICTOGRAPHIC.test(ch)) return true
  }
  return g.includes('️')
}

function graphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter('ro', { granularity: 'grapheme' })
    return Array.from(seg.segment(text), (s) => s.segment)
  }
  return Array.from(text)
}

function plainWeight(text: string): number {
  let total = 0
  for (const g of graphemes(text)) {
    if (isEmojiGrapheme(g)) {
      total += 2
      continue
    }
    for (const ch of g) total += codePointWeight(ch.codePointAt(0) ?? 0)
  }
  return total
}

export function xLinks(text: string): string[] {
  const out: string[] = []
  for (const m of text.normalize('NFC').matchAll(LINK_RE)) {
    out.push(m[0].replace(TRAILING_PUNCT, ''))
  }
  return out
}

export function xWeightedLength(text: string): number {
  const normalized = text.normalize('NFC')
  let total = 0
  let cursor = 0
  for (const m of normalized.matchAll(LINK_RE)) {
    const link = m[0].replace(TRAILING_PUNCT, '')
    const start = m.index ?? 0
    total += plainWeight(normalized.slice(cursor, start)) + X_URL_LENGTH
    cursor = start + link.length
  }
  return total + plainWeight(normalized.slice(cursor))
}
