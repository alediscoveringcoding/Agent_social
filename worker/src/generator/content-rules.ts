// W4: port of the site's link masking and bare-domain checks.
const OUR_DOMAINS = ['taxes.support', 'thecrypto.support'];
function escapeRegExp(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
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

/** Hosts a dev.to / Hashnode / Medium canonical URL may point at (the site's BLOG_HOSTS). */
export const BLOG_HOSTS: readonly string[] = ["thecrypto.support", "www.thecrypto.support", "taxes.support", "www.taxes.support"];

/** Is this a canonical URL on one of our blogs (https, our host)? Same as the site's isOurBlogUrl. */
export function isOurBlogUrl(value: unknown): boolean {
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && BLOG_HOSTS.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Same letters with the Romanian diacritics removed (the site's stripDiacritics). */
export function stripDiacritics(text: string): string {
  return text
    .replace(/[ăâ]/g, "a").replace(/[ĂÂ]/g, "A")
    .replace(/î/g, "i").replace(/Î/g, "I")
    .replace(/[șş]/g, "s").replace(/[ȘŞ]/g, "S")
    .replace(/[țţ]/g, "t").replace(/[ȚŢ]/g, "T");
}

/** Lowercase, diacritics folded, whitespace collapsed. */
export function fold(text: string): string {
  return stripDiacritics(text).toLowerCase().replace(/\s+/g, " ");
}

/** Banned phrases found in the text: word-start anchored, diacritics folded, whitespace collapsed (the site's findBannedPhrases). */
export function findBannedPhrases(text: string, phrases: readonly string[]): string[] {
  const folded = fold(text);
  return phrases.filter((p) => {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(fold(p)).replace(/ /g, "\\s+")}`, "u");
    return re.test(folded);
  });
}
