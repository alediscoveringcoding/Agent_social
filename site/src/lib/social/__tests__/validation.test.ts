import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateCardSpec, validateDestination, type ValidateDestinationInput } from '../validation.ts'

const NOW = new Date('2026-11-01T08:00:00Z')
const LATER = '2026-11-02T08:00:00Z'

function base(over: Partial<ValidateDestinationInput> = {}): ValidateDestinationInput {
  return {
    platform: 'linkedin-page',
    text: 'Afla ce trebuie sa stii despre declaratie.',
    settings: {},
    media: [],
    figures: [],
    scheduledAt: LATER,
    now: NOW,
    ...over,
  }
}

const codes = (v: ReturnType<typeof validateDestination>) => v.errors.map((e) => e.code)

describe('validateDestination: hard checks of PRD 8.2 block approval', () => {
  it('passes a clean LinkedIn post', () => {
    const v = validateDestination(base())
    assert.equal(v.ok, true, JSON.stringify(v.errors))
    assert.equal(v.containsFigures, false)
  })

  it('diacritics anywhere published: text, title, alt text', () => {
    assert.deepEqual(codes(validateDestination(base({ text: 'Știai asta?' }))), ['DIACRITICS'])
    const article = validateDestination(
      base({
        platform: 'devto',
        text: 'corp',
        settings: { title: 'Titlu cu ă', canonical_url: 'https://thecrypto.support/ghid/a' },
      })
    )
    assert.ok(codes(article).includes('DIACRITICS'))
    const alt = validateDestination(base({ media: [{ altText: 'Imagine cu ț', width: 1080, height: 1080 }] }))
    assert.ok(codes(alt).includes('DIACRITICS'))
  })

  it('banned phrase, legal name and bare domain', () => {
    assert.ok(codes(validateDestination(base({ text: 'Profit sigur pentru tine' }))).includes('BANNED_PHRASE'))
    assert.ok(
      codes(validateDestination(base({ text: 'Un produs Exemplu SRL', legalNames: ['Exemplu SRL'] }))).includes(
        'LEGAL_NAME'
      )
    )
    assert.ok(codes(validateDestination(base({ text: 'Intra pe thecrypto.support' }))).includes('BARE_DOMAIN'))
    assert.ok(validateDestination(base({ text: 'Intra pe https://thecrypto.support/ghid' })).ok)
  })

  it('length per platform, X weighted', () => {
    const x = validateDestination(base({ platform: 'x', text: 'a'.repeat(257) + ' https://x.com/' }))
    assert.deepEqual(codes(x), ['TOO_LONG'])
    assert.equal(x.length, 281)
    assert.ok(validateDestination(base({ platform: 'x', text: 'a'.repeat(256) + ' https://x.com/' })).ok)
    assert.ok(codes(validateDestination(base({ text: 'a'.repeat(3001) }))).includes('TOO_LONG'))
  })

  it('a lower limit from the Postiz channel rules wins', () => {
    const v = validateDestination(base({ text: 'a'.repeat(1300), rules: { max_length: 1200 } }))
    assert.deepEqual(codes(v), ['TOO_LONG'])
    assert.equal(v.maxLength, 1200)
  })

  it('Instagram: an image, no link, at most 30 hashtags, aspect 4:5 to 1.91:1', () => {
    const ig = (o: Partial<ValidateDestinationInput>) =>
      codes(validateDestination(base({ platform: 'instagram', ...o })))
    assert.deepEqual(ig({}), ['IG_NO_IMAGE'])
    const img = { altText: 'Card', width: 1080, height: 1350 }
    assert.deepEqual(ig({ media: [img] }), [])
    assert.ok(ig({ media: [img], text: 'Ghid: https://thecrypto.support/ghid' }).includes('IG_URL'))
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ')
    assert.ok(ig({ media: [img], text: tags }).includes('IG_HASHTAGS'))
    assert.ok(ig({ media: [{ altText: 'Lung', width: 1080, height: 1920 }] }).includes('IG_ASPECT'))
  })

  it('X takes at most 4 images; every image needs alt text', () => {
    const img = { altText: 'Card', width: 1600, height: 900 }
    assert.ok(codes(validateDestination(base({ platform: 'x', media: [img, img, img, img, img] }))).includes('TOO_MANY_IMAGES'))
    assert.deepEqual(codes(validateDestination(base({ media: [{ altText: '  ', width: 1, height: 1 }] }))), [
      'ALT_TEXT_MISSING',
    ])
  })

  it('dev.to and Hashnode need a title and a canonical link to our blog', () => {
    const dev = (settings: Record<string, unknown>) =>
      codes(validateDestination(base({ platform: 'devto', text: '# Corp', settings })))
    assert.deepEqual(dev({}).sort(), ['CANONICAL_MISSING', 'TITLE_MISSING'])
    assert.deepEqual(dev({ title: 'T', canonical_url: 'https://medium.com/x' }), ['CANONICAL_NOT_OURS'])
    assert.deepEqual(dev({ title: 'T', canonical_url: 'https://thecrypto.support/ghid/x' }), [])
    assert.deepEqual(
      dev({ title: 'T', canonical_url: 'https://thecrypto.support/ghid/x', tags: ['a', 'b', 'c', 'd', 'e'] }),
      ['TOO_MANY_TAGS']
    )
  })

  it('Product Hunt: name, tagline <= 60, description <= 260', () => {
    const ph = (text: string, settings: Record<string, unknown>) =>
      codes(validateDestination(base({ platform: 'producthunt', text, settings })))
    assert.deepEqual(ph('Descriere', { name: 'Taxes Support', tagline: 'Taxe crypto, simplu', maker_comment: 'Salut' }), [])
    assert.deepEqual(ph('Descriere', { name: 'N', tagline: 'x'.repeat(61), maker_comment: 'c' }), ['PH_TAGLINE_TOO_LONG'])
    assert.deepEqual(ph('d'.repeat(261), { name: 'N', tagline: 't', maker_comment: 'c' }), ['TOO_LONG'])
  })

  it('figures: detected, and an unverified figure blocks', () => {
    const withFigures = validateDestination(
      base({ text: 'Impozitul e 16% din 2026.', figures: [{ value: '16%', source: 'facts' }] })
    )
    assert.equal(withFigures.ok, true)
    assert.equal(withFigures.containsFigures, true)
    const unverified = validateDestination(
      base({ text: 'Plafonul e 600 lei.', figures: [{ value: '600 lei', source: 'unverified' }] })
    )
    assert.deepEqual(codes(unverified), ['UNVERIFIED_FIGURE'])
  })

  it('needs a time, in the future', () => {
    assert.deepEqual(codes(validateDestination(base({ scheduledAt: null }))), ['MISSING_TIME'])
    assert.deepEqual(codes(validateDestination(base({ scheduledAt: '2026-10-31T08:00:00Z' }))), ['TIME_IN_PAST'])
  })
})

describe('validateCardSpec (PRD 10.5 limits)', () => {
  const card = {
    template: 'dark',
    headline: 'Impozitul pe castigurile crypto creste',
    keyword: 'creste',
    stat: '16%',
    subline: 'Din anul fiscal 2026. Afla ce inseamna pentru tine.',
    brand: 'the-crypto-support',
  }
  it('accepts the PRD example', () => {
    assert.deepEqual(validateCardSpec(card), [])
  })
  it('enforces the limits and the keyword', () => {
    const issues = validateCardSpec({
      ...card,
      template: 'neon',
      headline: 'x'.repeat(71),
      keyword: 'lipsa',
      stat: '123456789',
      subline: 'y'.repeat(111),
    }).map((i) => i.code)
    assert.deepEqual(issues.sort(), [
      'CARD_HEADLINE_TOO_LONG',
      'CARD_KEYWORD',
      'CARD_STAT_TOO_LONG',
      'CARD_SUBLINE_TOO_LONG',
      'CARD_TEMPLATE',
    ])
  })
  it('applies the text rules to the card too', () => {
    assert.ok(validateCardSpec({ ...card, headline: 'Profit sigur', keyword: null }).some((i) => i.code === 'BANNED_PHRASE'))
  })
})
