/**
 * The card renderer (F3, PRD 10.5 and 8.3): every format x template x brand
 * renders a PNG of the format's size, and the element tree keeps the palette
 * rules (one gold element at most, white on #11A594 only at 24px+ bold).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ReactElement } from 'react'
import sharp from 'sharp'
import { CARD_FORMATS, CARD_FORMAT_NAMES, CARD_TEMPLATES } from '../constants.ts'
import { CARD_BRAND_SLUGS, TOKENS, cardBrand } from '../cards/palette.ts'
import { cardElement, cardText } from '../cards/layout.ts'
import { checkCardSpec, keywordRange, normalizeCardSpec, type CardSpec } from '../cards/spec.ts'
import { renderCardPng } from '../cards/render.ts'

const SPEC: Omit<CardSpec, 'template' | 'brand'> = {
  headline: 'Impozitul pe castigurile crypto creste din 2026',
  keyword: 'creste',
  stat: '16%',
  subline: 'Din anul fiscal 2026. Afla ce inseamna pentru tine.',
  alt_text: 'Card: impozitul pe castigurile crypto creste la 16%',
}

/** Each element with its style, own text and the background its text sits on. */
type Node = { style: Record<string, unknown>; text: string; bg: string | null }

function walk(el: ReactElement, inherited: string | null = null, out: Node[] = []): Node[] {
  const props = (el.props ?? {}) as { style?: Record<string, unknown>; children?: unknown }
  const style = props.style ?? {}
  const bg = (style.backgroundColor as string | undefined) ?? inherited
  const kids = ([] as unknown[]).concat(props.children ?? [])
  out.push({ style, text: kids.filter((k) => typeof k === 'string').join(''), bg })
  for (const k of kids) if (k && typeof k === 'object') walk(k as ReactElement, bg, out)
  return out
}

describe('card spec', () => {
  it('keeps the PRD 10.5 limits', () => {
    const ok = normalizeCardSpec({ ...SPEC, template: 'dark', brand: 'taxes-support' })
    assert.deepEqual(checkCardSpec(ok, { requireAlt: true }), [])
    const bad = normalizeCardSpec({
      template: 'dark',
      brand: 'taxes-support',
      headline: 'x'.repeat(71),
      keyword: 'lipsa',
      stat: '123456789',
      subline: 'y'.repeat(111),
    })
    assert.deepEqual(
      checkCardSpec(bad, { requireAlt: true }).map((i) => i.field),
      ['headline', 'keyword', 'stat', 'subline', 'alt_text']
    )
    assert.deepEqual(keywordRange('Taxa CRESTE acum', 'creste'), [5, 11])
  })

  it('drops characters the card fonts do not cover', () => {
    assert.equal(cardText('Taxe 🚀 crypto  2026'), 'Taxe crypto 2026')
    assert.equal(cardText('Pret: 10 €'), 'Pret: 10 €')
  })
})

describe('card layout rules (PRD 8.3)', () => {
  for (const template of CARD_TEMPLATES) {
    for (const format of CARD_FORMAT_NAMES) {
      it(`${template} ${format}: one gold element at most, white on accent only 24px+ bold`, () => {
        const nodes = walk(cardElement({ ...SPEC, template, brand: 'taxes-support' }, format, cardBrand('taxes-support')))
        const gold = nodes.filter((n) => n.style.color === TOKENS.gold || n.style.backgroundColor === TOKENS.gold)
        assert.equal(gold.length, 1, 'exactly the stat is gold')
        for (const n of nodes) {
          if (n.style.color === TOKENS.white && n.bg === TOKENS.accent && n.text) {
            assert.ok(Number(n.style.fontSize) >= 24, `white on accent at ${String(n.style.fontSize)}px`)
            assert.ok(Number(n.style.fontWeight) >= 700, 'white on accent must be bold')
          }
        }
      })
    }
  }

  it('has no gold element without a stat', () => {
    const nodes = walk(cardElement({ ...SPEC, stat: null, template: 'dark', brand: 'x' }, 'square', cardBrand('x')))
    assert.equal(nodes.filter((n) => n.style.color === TOKENS.gold || n.style.backgroundColor === TOKENS.gold).length, 0)
  })
})

describe('card renderer', () => {
  for (const format of CARD_FORMAT_NAMES) {
    it(`renders ${format} for every template and brand at ${CARD_FORMATS[format].width}x${CARD_FORMATS[format].height}`, async () => {
      for (const template of CARD_TEMPLATES) {
        for (const slug of CARD_BRAND_SLUGS) {
          const card = await renderCardPng({ ...SPEC, template, brand: slug }, format, cardBrand(slug))
          const meta = await sharp(card.bytes).metadata()
          assert.equal(meta.format, 'png', `${template}/${slug}`)
          assert.equal(meta.width, CARD_FORMATS[format].width, `${template}/${slug} width`)
          assert.equal(meta.height, CARD_FORMATS[format].height, `${template}/${slug} height`)
          assert.ok(card.bytes.length < 8 * 1024 * 1024)
        }
      }
    })
  }

  it('renders a card with only a headline', async () => {
    const card = await renderCardPng({ template: 'mint', brand: 'comets-of-web3', headline: 'Scurt' }, 'devto_cover', cardBrand('comets-of-web3'))
    assert.equal((await sharp(card.bytes).metadata()).width, 1000)
  })
})
