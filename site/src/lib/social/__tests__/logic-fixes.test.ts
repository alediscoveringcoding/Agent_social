import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildHandoff } from '../handoff.ts'
import { reconcileFigures } from '../draft-edit.ts'
import { unlistedFigures } from '../figures.ts'
import { isHttpsUrl } from '../validation.ts'
import { DraftSchema } from '../schemas.ts'
import { PLATFORMS } from '../constants.ts'

const fig = (value: string) => ({ value, context: null, source: 'confirmed' as const })

describe('handoff article fields', () => {
  it('gives social platforms on an article post no article fields', () => {
    for (const platform of ['quora', 'tradingview', 'youtube', 'x'] as const) {
      const h = buildHandoff({ platform, kind: 'article', title: 'Titlu', text: 'Salut', settings: {}, article: { title: 'Titlu', subtitle: 'Sub' } })
      assert.ok(!h.fields.some((f) => f.key === 'subtitle'), platform)
    }
    const real = buildHandoff({ platform: 'substack', kind: 'article', title: 'Titlu', text: '', settings: {}, article: { subtitle: 'Sub', body_markdown: 'x' } })
    assert.ok(real.fields.some((f) => f.key === 'subtitle'))
  })
})

describe('unlistedFigures', () => {
  it('does not let a short listed figure hide a longer one', () => {
    assert.equal(unlistedFigures('Creste cu 15%.', [fig('5%')]).length, 1)
    assert.equal(unlistedFigures('Avem 12 clienti.', [fig('2')]).length, 1)
  })
  it('treats spacing, decimal commas and trailing zeros as the same figure', () => {
    assert.equal(unlistedFigures('Creste cu 15 %.', [fig('15%')]).length, 0)
    assert.equal(unlistedFigures('Creste cu 15,0%.', [fig('15%')]).length, 0)
    assert.equal(unlistedFigures('Creste cu 1,5%.', [fig('1.5%')]).length, 0)
    assert.equal(unlistedFigures('Creste cu 1,5%.', [fig('15%')]).length, 1)
  })
})

describe('reconcileFigures duplicates', () => {
  it('keeps two base figures with the same value and different sources', () => {
    const base = [
      { value: '20%', context: 'a', source: 'confirmed' as const, confirmed_by: 'x@y.z', confirmed_at: '2026-01-01T00:00:00Z' },
      { value: '20%', context: 'b', source: 'unverified' as const },
    ]
    const out = reconcileFigures(base, base, 'me@example.test', new Date('2026-10-10T00:00:00Z'))
    assert.deepEqual(out.map((f) => f.source), ['confirmed', 'unverified'])
    assert.equal(out[0].confirmed_by, 'x@y.z')
  })
  it('still refuses an illegal source change', () => {
    const base = [{ value: '20%', context: null, source: 'article' }]
    assert.throws(() => reconcileFigures(base, [{ value: '20%', context: null, source: 'unverified' }], 'me@example.test', new Date()))
  })
})

describe('isHttpsUrl', () => {
  it('accepts https only', () => {
    assert.equal(isHttpsUrl('https://example.test/x'), true)
    assert.equal(isHttpsUrl('http://example.test/x'), false)
    assert.equal(isHttpsUrl('javascript:alert(1)'), false)
  })
})

describe('DraftSchema variants', () => {
  it('allows one variant per platform', () => {
    const variants = Array.from({ length: PLATFORMS.length }, (_, i) => ({ platform: PLATFORMS[i], text: 'x' }))
    assert.equal(DraftSchema.shape.variants.safeParse(variants).success, true)
    assert.equal(DraftSchema.shape.variants.safeParse([...variants, variants[0]]).success, false)
  })
})
