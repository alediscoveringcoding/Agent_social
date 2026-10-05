/**
 * Brand card palette and templates (PRD 8.3). Pure: the renderer, the card
 * editor in the browser and the tests all read it.
 *
 * Rules the layout keeps (and cards.test.ts checks on the element tree):
 *  - at most one gold element per card (the stat);
 *  - white text on ACCENT (#11A594) only at 24px+ bold;
 *  - radius 22px where shapes are used;
 *  - Plus Jakarta Sans 400/600/700/800.
 */

import type { CardTemplate } from '../constants.ts'

export const TOKENS = {
  ink: '#16313A',
  inkSoft: '#5D7178',
  accent: '#11A594',
  accentDark: '#0C7F72',
  darkAccent: '#2DD4BE',
  accentSoft: '#D6F0EA',
  bgSoft: '#F4FAF8',
  bgMint: '#E7F5F0',
  gold: '#E8A805',
  white: '#FFFFFF',
} as const

export const CARD_RADIUS = 22

export interface TemplateColors {
  background: string
  /** Headline text. */
  headline: string
  /** The keyword inside the headline. */
  keyword: string
  /** Subline and secondary lines. */
  subline: string
  /** Brand name in the footer. */
  footer: string
  /** Decorative shapes (bar under the headline, corner shape). */
  shape: string
  /** The stat: gold as text (dark) or as the pill behind ink text (light, mint). */
  stat: { text: string; pill: string | null }
}

export const TEMPLATES: Record<CardTemplate, TemplateColors> = {
  // White, ink headline, teal accent, ink-soft footer.
  light: {
    background: TOKENS.white,
    headline: TOKENS.ink,
    keyword: TOKENS.accentDark,
    subline: TOKENS.inkSoft,
    footer: TOKENS.inkSoft,
    shape: TOKENS.accent,
    stat: { text: TOKENS.ink, pill: TOKENS.gold },
  },
  // Ink background, white headline, #2DD4BE keyword, gold stat.
  dark: {
    background: TOKENS.ink,
    headline: TOKENS.white,
    keyword: TOKENS.darkAccent,
    subline: '#C5D3CF',
    footer: '#C5D3CF',
    shape: TOKENS.accent,
    stat: { text: TOKENS.gold, pill: null },
  },
  // Mint background, ink text, #0C7F72 for the call to action (the keyword).
  mint: {
    background: TOKENS.bgMint,
    headline: TOKENS.ink,
    keyword: TOKENS.accentDark,
    subline: TOKENS.inkSoft,
    footer: TOKENS.ink,
    shape: TOKENS.accentDark,
    stat: { text: TOKENS.ink, pill: TOKENS.gold },
  },
}

/** The three brands (seeded in 0001). An unknown slug renders with its own name. */
export const CARD_BRANDS = {
  'taxes-support': { name: 'Taxes Support', mark: 'TS' },
  'the-crypto-support': { name: 'The Crypto Support', mark: 'TC' },
  'comets-of-web3': { name: 'Comets of Web3', mark: 'CW' },
} as const satisfies Record<string, { name: string; mark: string }>
export type CardBrandSlug = keyof typeof CARD_BRANDS
export const CARD_BRAND_SLUGS = Object.keys(CARD_BRANDS) as CardBrandSlug[]

export interface CardBrand {
  slug: string
  name: string
  mark: string
}

export function cardBrand(slug: string, name?: string | null): CardBrand {
  const known = (CARD_BRANDS as Record<string, { name: string; mark: string }>)[slug]
  if (known) return { slug, name: known.name, mark: known.mark }
  const label = (name || slug || 'Brand').trim()
  const mark =
    label
      .split(/[\s-]+/)
      .filter(Boolean)
      .map((w) => w[0]!.toUpperCase())
      .join('')
      .slice(0, 2) || 'B'
  return { slug, name: label, mark }
}
