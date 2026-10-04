/**
 * Content rules of PRD section 8, as plain text checks. Pure: the composer runs
 * them live in the browser and the server runs them again before approval
 * (the server is authoritative).
 *
 * BANNED_PHRASES mirrors `worker/prompts/banned.txt` in the infra repo. A change
 * goes to both files in the same week, or the generator and the site disagree
 * about what may be published.
 */

/** PRD 8.2. Lowercase; matched case-insensitively at a word start. */
export const BANNED_PHRASES: readonly string[] = [
  'to the moon',
  'garantat',
  'profit sigur',
  'pretul va',
  'investeste acum',
]

/** Our domains: allowed only inside a link (PRD 8.1, 8.2). */
export const OUR_DOMAINS: readonly string[] = ['taxes.support', 'thecrypto.support']

/** Hosts a dev.to / Hashnode canonical URL may point at (our blogs). */
export const BLOG_HOSTS: readonly string[] = [
  'thecrypto.support',
  'www.thecrypto.support',
  'taxes.support',
  'www.taxes.support',
]

/** Brand names, written exactly like this (PRD 8.1). */
export const BRAND_NAMES: readonly string[] = ['Taxes Support', 'The Crypto Support']

const DIACRITICS = /[ăâîșşțţĂÂÎȘŞȚŢ]/g

export function findDiacritics(text: string): string[] {
  return [...new Set(text.match(DIACRITICS) ?? [])]
}

/** Same letters with the diacritics removed (a convenience for the composer). */
export function stripDiacritics(text: string): string {
  return text
    .replace(/[ăâ]/g, 'a')
    .replace(/[ĂÂ]/g, 'A')
    .replace(/î/g, 'i')
    .replace(/Î/g, 'I')
    .replace(/[șş]/g, 's')
    .replace(/[ȘŞ]/g, 'S')
    .replace(/[țţ]/g, 't')
    .replace(/[ȚŢ]/g, 'T')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Lowercase, diacritics folded, whitespace collapsed: "Prețul  va" -> "pretul va". */
function fold(text: string): string {
  return stripDiacritics(text).toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Banned phrases found in the text. Matched at a word START, so "garantat"
 * also catches "garantata" / "garantate" but not "negarantat".
 */
export function findBannedPhrases(text: string, phrases: readonly string[] = BANNED_PHRASES): string[] {
  const folded = fold(text)
  return phrases.filter((p) => {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(fold(p)).replace(/ /g, '\\s+')}`, 'u')
    return re.test(folded)
  })
}

/** Operator company names found in the text (case-insensitive, whole words). */
export function findLegalNames(text: string, names: readonly string[]): string[] {
  const folded = fold(text)
  return names.filter((n) => {
    const name = fold(n).trim()
    if (!name) return false
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name).replace(/ /g, '\\s+')}($|[^\\p{L}\\p{N}])`, 'u')
    return re.test(folded)
  })
}

export interface UrlMatch {
  url: string
  index: number
}

const TRAILING_PUNCT = /[.,;:!?)\]}'"»]+$/

/** Explicit links: http(s)://… and www.… (trailing punctuation is not part of a link). */
export function findUrls(text: string): UrlMatch[] {
  const out: UrlMatch[] = []
  const re = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const url = m[0].replace(TRAILING_PUNCT, '')
    out.push({ url, index: m.index })
  }
  return out
}

/** The text with every explicit link replaced by spaces (same length, same indexes). */
export function maskUrls(text: string): string {
  let out = text
  for (const { url, index } of findUrls(text)) {
    out = out.slice(0, index) + ' '.repeat(url.length) + out.slice(index + url.length)
  }
  return out
}

/**
 * Our domains written as words in a sentence, i.e. outside a link: "taxes.support"
 * or "app.thecrypto.support" alone. Inside https://… they are fine.
 */
export function findBareDomains(text: string, domains: readonly string[] = OUR_DOMAINS): string[] {
  const masked = maskUrls(text).toLowerCase()
  const found = new Set<string>()
  for (const d of domains) {
    const re = new RegExp(`(^|[^a-z0-9.-])((?:[a-z0-9-]+\\.)*${escapeRegExp(d)})(?![a-z0-9-])`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(masked))) found.add(m[2])
  }
  return [...found]
}

/** Brand names written with the wrong casing or spacing ("taxes support", "TheCryptoSupport"). */
export function findMiswrittenBrandNames(text: string): string[] {
  const out: string[] = []
  for (const name of BRAND_NAMES) {
    const loose = new RegExp(name.split(' ').map(escapeRegExp).join('\\s*'), 'gi')
    let m: RegExpExecArray | null
    while ((m = loose.exec(text))) {
      if (m[0] !== name) out.push(m[0])
    }
  }
  return [...new Set(out)]
}

export function countHashtags(text: string): number {
  return (maskUrls(text).match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length
}

/** Is this a canonical URL on one of our blogs (https, our host)? */
export function isOurBlogUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && BLOG_HOSTS.includes(url.hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * The operator's legal name(s), from `SOCIAL_LEGAL_NAMES` (comma separated).
 * Kept out of the source on purpose: the contracts live in a public repository.
 */
export function legalNamesFromEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
