/**
 * Card spec limits (PRD 10.5) and the checks run before a card is rendered.
 * Pure, so the card editor shows the same messages live.
 */

import { CARD_TEMPLATES, type CardTemplate } from '../constants.ts'

export const CARD_LIMITS = { headline: 70, stat: 8, subline: 110, altText: 1000 } as const

export interface CardSpec {
  template: CardTemplate
  headline: string
  keyword?: string | null
  stat?: string | null
  subline?: string | null
  /** Brand slug; the post's brand wins when a card is rendered for a post. */
  brand: string
  alt_text?: string | null
}

export interface CardIssue {
  field: 'template' | 'headline' | 'keyword' | 'stat' | 'subline' | 'alt_text'
  message: string
}

/** Trimmed copy with empty optional fields as null. */
export function normalizeCardSpec(input: Partial<CardSpec> & { brand: string }): CardSpec {
  const opt = (v: string | null | undefined) => {
    const t = (v ?? '').replace(/\s+/g, ' ').trim()
    return t ? t : null
  }
  const template = (CARD_TEMPLATES as readonly string[]).includes(input.template ?? '') ? (input.template as CardTemplate) : 'light'
  return {
    template,
    headline: (input.headline ?? '').replace(/\s+/g, ' ').trim(),
    keyword: opt(input.keyword),
    stat: opt(input.stat),
    subline: opt(input.subline),
    brand: input.brand,
    alt_text: opt(input.alt_text),
  }
}

/** Where `keyword` sits in `headline`, using the exact approval match. */
export function keywordRange(headline: string, keyword: string | null | undefined): [number, number] | null {
  if (!keyword) return null
  const at = headline.indexOf(keyword)
  return at < 0 ? null : [at, at + keyword.length]
}

export function checkCardSpec(spec: CardSpec, opts: { requireAlt?: boolean } = {}): CardIssue[] {
  const out: CardIssue[] = []
  if (!(CARD_TEMPLATES as readonly string[]).includes(spec.template)) out.push({ field: 'template', message: 'Alege un sablon: Light, Dark sau Mint.' })
  if (!spec.headline) out.push({ field: 'headline', message: 'Titlul cardului lipseste.' })
  if (spec.headline.length > CARD_LIMITS.headline) {
    out.push({ field: 'headline', message: `Titlul are ${spec.headline.length} caractere; cel mult ${CARD_LIMITS.headline}.` })
  }
  if (spec.keyword && !keywordRange(spec.headline, spec.keyword)) {
    out.push({ field: 'keyword', message: 'Cuvantul evidentiat trebuie sa apara exact in titlu.' })
  }
  if (spec.stat && spec.stat.length > CARD_LIMITS.stat) {
    out.push({ field: 'stat', message: `Cifra are ${spec.stat.length} caractere; cel mult ${CARD_LIMITS.stat}.` })
  }
  if (spec.subline && spec.subline.length > CARD_LIMITS.subline) {
    out.push({ field: 'subline', message: `Subtitlul are ${spec.subline.length} caractere; cel mult ${CARD_LIMITS.subline}.` })
  }
  if (opts.requireAlt && !spec.alt_text) out.push({ field: 'alt_text', message: 'Scrie textul alternativ al cardului.' })
  if (spec.alt_text && spec.alt_text.length > CARD_LIMITS.altText) {
    out.push({ field: 'alt_text', message: `Textul alternativ are cel mult ${CARD_LIMITS.altText} caractere.` })
  }
  return out
}

/** A starting alt text when the generator gave none: what the card says. */
export function defaultCardAlt(spec: CardSpec, brandName: string): string {
  return [`Card ${brandName}: ${spec.headline}`, spec.stat ? `Cifra: ${spec.stat}.` : '', spec.subline ?? '']
    .filter(Boolean)
    .join(' ')
    .slice(0, CARD_LIMITS.altText)
}
