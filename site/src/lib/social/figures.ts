/**
 * Figure detection (PRD 8.2 "Figures"): any digit, `%`, `lei`, `RON`, `EUR`
 * or date makes a destination `contains_figures`, and approving it then needs
 * a person to tick "Am verificat cifrele". Deliberately over-inclusive: a tax
 * brand would rather tick one more box than publish one wrong number.
 *
 * One reading to know about: digits inside a LINK are not figures (a URL slug
 * like /ghid/2026-impozit states nothing to the reader). Everything else
 * counts, brand names included ("Comets of Web3" contains a figure).
 *
 * Pure, browser-safe.
 */

import { maskUrls } from './content-rules.ts'

export type FigureKind = 'number' | 'percent' | 'currency' | 'date'

export interface FigureMatch {
  value: string
  index: number
  kind: FigureKind
}

/** A figure as the generator lists it (PRD 10.5). */
export interface DraftFigure {
  value: string
  context?: string | null
  source: 'article' | 'facts' | 'unverified' | string
}

const MONTHS =
  'ianuarie|februarie|martie|aprilie|mai|iunie|iulie|august|septembrie|octombrie|noiembrie|decembrie|' +
  'ian|feb|mar|apr|iun|iul|aug|sep|sept|oct|noi|nov|dec'

const PATTERNS: ReadonlyArray<{ kind: FigureKind; re: RegExp }> = [
  // "25 mai", "1 ianuarie 2027"
  { kind: 'date', re: new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS})\\b(?:\\s+\\d{4})?`, 'giu') },
  // 25.05.2026, 2026-05-25, 25/05
  { kind: 'date', re: /\b\d{1,4}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/g },
  // 16%, 16 %, 16,5%
  { kind: 'percent', re: /\d+(?:[.,]\d+)?\s?%/g },
  // 1.000 lei, 600 RON, 50 EUR, 50€, €50, $10
  {
    kind: 'currency',
    re: /(?:[€$]\s?\d+(?:[.,\s]\d{3})*(?:[.,]\d+)?)|(?:\d+(?:[.,\s]\d{3})*(?:[.,]\d+)?\s?(?:lei|ron|eur|euro|€|\$)(?![\p{L}\p{N}]))/giu,
  },
  // a lone % or currency word: "procent", no; "%", yes
  { kind: 'percent', re: /%/g },
  { kind: 'currency', re: /(?<![\p{L}\p{N}])(?:lei|ron|eur)(?![\p{L}\p{N}])|[€$]/giu },
  // any other digit run
  { kind: 'number', re: /\d+(?:[.,]\d+)*/g },
]

/** Figures in reading order; overlapping matches keep the first, longest one. */
export function detectFigures(text: string): FigureMatch[] {
  const masked = maskUrls(text)
  const found: FigureMatch[] = []
  const taken: Array<[number, number]> = []
  const overlaps = (a: number, b: number) => taken.some(([s, e]) => a < e && b > s)

  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(masked))) {
      const value = m[0].trim()
      if (!value) continue
      const start = m.index + (m[0].length - m[0].trimStart().length)
      const end = start + value.length
      if (overlaps(start, end)) continue
      taken.push([start, end])
      found.push({ value: text.slice(start, end), index: start, kind })
    }
  }
  return found.sort((a, b) => a.index - b.index)
}

export function containsFigures(text: string): boolean {
  return detectFigures(text).length > 0
}

/** Listed figures whose source is `unverified`: these block approval (PRD F2, 8.2). */
export function unverifiedFigures(figures: ReadonlyArray<DraftFigure>): DraftFigure[] {
  return figures.filter((f) => f.source === 'unverified')
}

function normalizeFigure(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').replace(',', '.')
}

/**
 * Figures in the text that the draft's list does not mention (an edit added a
 * number). A warning, not a block: the "figures checked" tick covers it.
 */
export function unlistedFigures(text: string, listed: ReadonlyArray<DraftFigure>): FigureMatch[] {
  const known = listed.map((f) => normalizeFigure(f.value))
  return detectFigures(text).filter((m) => {
    if (m.kind === 'number' && m.value.length <= 1) return false
    const v = normalizeFigure(m.value)
    return !known.some((k) => k.includes(v) || v.includes(k))
  })
}
