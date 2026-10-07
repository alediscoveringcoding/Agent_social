/**
 * The card as an element tree for Satori (next/og). Written with
 * createElement rather than JSX so the test runner (type stripping only) can
 * load it and check the palette rules on the tree itself.
 *
 * Square and portrait stack stat, headline and subline; the wide formats put
 * the stat in a column on the right. Brand mark and name sit bottom-left.
 */

import { createElement, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { CARD_FORMATS, type CardFormat } from '../constants.ts'
import { CARD_FONT_FAMILY } from './fonts.ts'
import { CARD_RADIUS, TEMPLATES, TOKENS, type CardBrand } from './palette.ts'
import { keywordRange, type CardSpec } from './spec.ts'

interface Metrics {
  pad: number
  headline: number
  subline: number
  stat: number
  mark: number
  brand: number
  gap: number
  wide: boolean
}

export const CARD_METRICS: Record<CardFormat, Metrics> = {
  square: { pad: 88, headline: 78, subline: 34, stat: 120, mark: 60, brand: 30, gap: 32, wide: false },
  portrait: { pad: 96, headline: 86, subline: 38, stat: 140, mark: 64, brand: 32, gap: 40, wide: false },
  x: { pad: 96, headline: 74, subline: 34, stat: 136, mark: 60, brand: 30, gap: 28, wide: true },
  devto_cover: { pad: 44, headline: 44, subline: 22, stat: 76, mark: 48, brand: 24, gap: 14, wide: true },
  hashnode_cover: { pad: 88, headline: 70, subline: 32, stat: 128, mark: 56, brand: 28, gap: 26, wide: true },
  ph_gallery: { pad: 72, headline: 60, subline: 28, stat: 110, mark: 52, brand: 26, gap: 22, wide: true },
  // 1000x1500 (2:3), stacked like the portrait card.
  pinterest: { pad: 88, headline: 82, subline: 36, stat: 132, mark: 60, brand: 30, gap: 36, wide: false },
}

/** Corner shape opacity per template: a quiet accent, never a second focus. */
const CORNER_OPACITY = { light: 0.14, dark: 0.18, mint: 0.16 } as const

/**
 * Only what the loaded fonts cover (Latin, Latin Extended, common
 * punctuation, the euro sign). Anything else (emoji, other scripts) would make
 * the renderer fetch fonts from the network, so it is dropped.
 */
export function cardText(s: string | null | undefined): string {
  return (s ?? '').replace(/[^ -ɏ‐-‧‰-⁞€]/g, '').replace(/\s+/g, ' ').trim()
}

function h(type: string, style: CSSProperties, ...children: ReactNode[]): ReactElement {
  return createElement(type, { style }, ...children)
}

function headlineSize(base: number, length: number): number {
  if (length <= 36) return base
  if (length <= 52) return Math.round(base * 0.88)
  return Math.round(base * 0.78)
}

function headline(spec: CardSpec, size: number, color: string, keywordColor: string): ReactElement {
  const text = cardText(spec.headline)
  const range = keywordRange(text, cardText(spec.keyword))
  const words: ReactElement[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const start = m.index
    const end = start + m[0].length
    const hot = range !== null && start < range[1] && end > range[0]
    words.push(
      createElement(
        'span',
        { key: String(start), style: { color: hot ? keywordColor : color, marginRight: Math.round(size * 0.26) } },
        m[0]
      )
    )
  }
  return h(
    'div',
    {
      display: 'flex',
      flexWrap: 'wrap',
      fontSize: size,
      fontWeight: 800,
      lineHeight: 1.12,
      letterSpacing: -0.5,
      color,
    },
    ...words
  )
}

function stat(spec: CardSpec, size: number, template: CardSpec['template']): ReactElement | null {
  const value = cardText(spec.stat)
  if (!value) return null
  const c = TEMPLATES[template].stat
  if (c.pill) {
    // The one gold element: a pill behind ink text (gold text on white would not read).
    return h(
      'div',
      {
        display: 'flex',
        alignSelf: 'flex-start',
        backgroundColor: c.pill,
        color: c.text,
        borderRadius: CARD_RADIUS,
        padding: `${Math.round(size * 0.1)}px ${Math.round(size * 0.24)}px`,
        fontSize: Math.round(size * 0.82),
        fontWeight: 800,
        lineHeight: 1,
      },
      value
    )
  }
  return h('div', { display: 'flex', color: c.text, fontSize: size, fontWeight: 800, lineHeight: 1 }, value)
}

function footer(brand: CardBrand, m: Metrics, color: string): ReactElement {
  const initials = Math.max(24, Math.round(m.mark * 0.42))
  return h(
    'div',
    { display: 'flex', alignItems: 'center' },
    h(
      'div',
      {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: m.mark,
        height: m.mark,
        borderRadius: m.mark,
        backgroundColor: TOKENS.accent,
        // White on accent: 24px+ and bold only (PRD 8.3).
        color: TOKENS.white,
        fontSize: initials,
        fontWeight: 800,
        letterSpacing: -0.5,
      },
      cardText(brand.mark) || 'B'
    ),
    h('div', { display: 'flex', marginLeft: Math.round(m.mark * 0.3), color, fontSize: m.brand, fontWeight: 700 }, cardText(brand.name))
  )
}

export function cardElement(spec: CardSpec, format: CardFormat, brand: CardBrand): ReactElement {
  const { width, height } = CARD_FORMATS[format]
  const m = CARD_METRICS[format]
  const t = TEMPLATES[spec.template]
  const title = headline(spec, headlineSize(m.headline, cardText(spec.headline).length), t.headline, t.keyword)
  const sub = cardText(spec.subline)
  const subline = sub
    ? h('div', { display: 'flex', marginTop: m.gap, fontSize: m.subline, fontWeight: 600, lineHeight: 1.35, color: t.subline }, sub)
    : null
  const statEl = stat(spec, m.stat, spec.template)
  const corner = Math.round(Math.min(width, height) * 0.46)

  // In a row (wide formats) the text takes the room the stat leaves; in a column it keeps its height, so it centers.
  const text = h('div', { display: 'flex', flexDirection: 'column', flexGrow: m.wide ? 1 : 0, flexShrink: 1 }, title, subline)
  const body = m.wide
    ? h(
        'div',
        { display: 'flex', flexDirection: 'row', alignItems: 'center', flexGrow: 1 },
        text,
        statEl ? h('div', { display: 'flex', marginLeft: m.gap * 2, flexShrink: 0 }, statEl) : null
      )
    : h(
        'div',
        { display: 'flex', flexDirection: 'column', justifyContent: 'center', flexGrow: 1 },
        statEl ? h('div', { display: 'flex', marginBottom: m.gap }, statEl) : null,
        text
      )

  return h(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
      width,
      height,
      padding: m.pad,
      backgroundColor: t.background,
      fontFamily: CARD_FONT_FAMILY,
      overflow: 'hidden',
    },
    // Corner shape, decorative.
    h('div', {
      display: 'flex',
      position: 'absolute',
      top: -Math.round(corner * 0.38),
      right: -Math.round(corner * 0.38),
      width: corner,
      height: corner,
      borderRadius: CARD_RADIUS * 3,
      backgroundColor: t.shape,
      opacity: CORNER_OPACITY[spec.template],
    }),
    // Accent bar: the teal underline motif of the site.
    h('div', {
      display: 'flex',
      width: Math.round(m.mark * 1.8),
      height: Math.max(8, Math.round(m.mark * 0.16)),
      borderRadius: CARD_RADIUS,
      backgroundColor: t.shape,
      marginBottom: m.gap,
    }),
    body,
    h('div', { display: 'flex', marginTop: m.gap }, footer(brand, m, t.footer))
  )
}
