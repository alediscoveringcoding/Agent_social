import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  countHashtags,
  findBannedPhrases,
  findBareDomains,
  findDiacritics,
  findLegalNames,
  findMiswrittenBrandNames,
  findUrls,
  isOurBlogUrl,
  legalNamesFromEnv,
  stripDiacritics,
} from '../content-rules.ts'
import { containsFigures, detectFigures, unlistedFigures, unverifiedFigures } from '../figures.ts'
import { xWeightedLength } from '../x-length.ts'

describe('diacritics (PRD 8.1: none allowed)', () => {
  it('finds every Romanian diacritic, comma-below and cedilla forms, both cases', () => {
    assert.deepEqual(findDiacritics('ă â î ș ş ț ţ Ă Â Î Ș Ş Ț Ţ').length, 14)
  })
  it('passes plain Romanian', () => {
    assert.deepEqual(findDiacritics('Ai pana pe 25 mai sa depui Declaratia Unica.'), [])
  })
  it('strips them to the plain letters', () => {
    assert.equal(stripDiacritics('Știai că prețul e în lei?'), 'Stiai ca pretul e in lei?')
  })
})

describe('banned phrases', () => {
  it('matches case-insensitively and across extra spaces', () => {
    assert.deepEqual(findBannedPhrases('Mergem TO  THE MOON!'), ['to the moon'])
  })
  it('matches a word start, so inflections are caught', () => {
    assert.deepEqual(findBannedPhrases('Castig garantata pentru toti'), ['garantat'])
  })
  it('does not match inside another word', () => {
    assert.deepEqual(findBannedPhrases('Un produs negarantat'), [])
  })
  it('folds diacritics before matching', () => {
    assert.deepEqual(findBannedPhrases('Prețul va creste'), ['pretul va'])
  })
})

describe('legal name', () => {
  it('finds a configured name as whole words, any case', () => {
    assert.deepEqual(findLegalNames('Un produs Exemplu Firma SRL.', ['exemplu firma srl']), ['exemplu firma srl'])
    assert.deepEqual(findLegalNames('Exemplu Firmaxyz', ['Exemplu Firma']), [])
  })
  it('reads the list from a comma separated variable', () => {
    assert.deepEqual(legalNamesFromEnv(' A SRL, B SA ,,'), ['A SRL', 'B SA'])
    assert.deepEqual(legalNamesFromEnv(undefined), [])
  })
})

describe('bare domains (PRD 8.2: only as part of a URL)', () => {
  it('flags our domain in a sentence', () => {
    assert.deepEqual(findBareDomains('Intra pe taxes.support si afla.'), ['taxes.support'])
    assert.deepEqual(findBareDomains('Vezi app.thecrypto.support'), ['app.thecrypto.support'])
  })
  it('accepts it inside a link', () => {
    assert.deepEqual(findBareDomains('Ghidul: https://thecrypto.support/ghid/x.'), [])
    assert.deepEqual(findBareDomains('www.taxes.support/despre'), [])
  })
  it('ignores other domains', () => {
    assert.deepEqual(findBareDomains('Scrie pe example.com'), [])
  })
})

describe('brand names, links, hashtags, canonical', () => {
  it('flags a brand name with the wrong casing', () => {
    assert.deepEqual(findMiswrittenBrandNames('Echipa taxes support te ajuta. The Crypto Support la fel.'), [
      'taxes support',
    ])
  })
  it('trims trailing punctuation from links', () => {
    assert.deepEqual(findUrls('Vezi https://thecrypto.support/ghid/a, apoi.'), [
      { url: 'https://thecrypto.support/ghid/a', index: 5 },
    ])
  })
  it('counts hashtags but not URL fragments', () => {
    assert.equal(countHashtags('#crypto #taxe https://x.ro/#ancora #2026'), 3)
  })
  it('knows our blog hosts', () => {
    assert.equal(isOurBlogUrl('https://thecrypto.support/ghid/x'), true)
    assert.equal(isOurBlogUrl('http://thecrypto.support/ghid/x'), false)
    assert.equal(isOurBlogUrl('https://dev.to/x'), false)
    assert.equal(isOurBlogUrl('nu e link'), false)
  })
})

describe('figures (PRD 8.2)', () => {
  it('finds digits, percentages, currencies and dates', () => {
    const found = detectFigures('Impozitul e 16% din castig, peste 600 lei sau 50 EUR, pana pe 25 mai.')
    assert.deepEqual(
      found.map((f) => [f.value, f.kind]),
      [
        ['16%', 'percent'],
        ['600 lei', 'currency'],
        ['50 EUR', 'currency'],
        ['25 mai', 'date'],
      ]
    )
  })
  it('counts a currency word without a number', () => {
    assert.equal(containsFigures('Platesti in RON.'), true)
    assert.equal(containsFigures('Plata in lei'), true)
  })
  it('does not see figures in plain words or inside links', () => {
    assert.equal(containsFigures('Afla cum se calculeaza impozitul.'), false)
    assert.equal(containsFigures('Ghidul: https://thecrypto.support/ghid/2026-impozit'), false)
    assert.equal(containsFigures('Leii din parc'), false)
  })
  it('counts a digit in a brand name (over-inclusive on purpose)', () => {
    assert.equal(containsFigures('Comets of Web3'), true)
  })
  it('lists unverified and unlisted figures', () => {
    const listed = [
      { value: '16%', source: 'facts' },
      { value: '600 lei', source: 'unverified' },
    ]
    assert.deepEqual(unverifiedFigures(listed).map((f) => f.value), ['600 lei'])
    assert.deepEqual(
      unlistedFigures('16% si 600 lei si 10%', listed).map((f) => f.value),
      ['10%']
    )
  })
})

describe('X weighted length', () => {
  it('counts Latin text one per character', () => {
    assert.equal(xWeightedLength('Salut'), 5)
  })
  it('counts every link as 23', () => {
    assert.equal(xWeightedLength('Vezi https://thecrypto.support/ghid/un-ghid-foarte-lung-despre-taxe'), 5 + 23)
    assert.equal(xWeightedLength('example.com'), 23)
  })
  it('counts an emoji as 2, however many code points it has', () => {
    assert.equal(xWeightedLength('📅'), 2)
    assert.equal(xWeightedLength('👩‍💻'), 2)
    assert.equal(xWeightedLength('🇷🇴'), 2)
    assert.equal(xWeightedLength('👍🏽'), 2)
  })
  it('counts CJK as 2 and keeps punctuation ranges at 1', () => {
    assert.equal(xWeightedLength('日本'), 4)
    assert.equal(xWeightedLength('“a”'), 3)
  })
  it('counts Romanian diacritics as 1 (precomposed and combining forms alike)', () => {
    assert.equal(xWeightedLength('ș'), 1)
    assert.equal(xWeightedLength('ș'), 1)
  })
  it('puts a 280-character post exactly at the limit', () => {
    assert.equal(xWeightedLength('a'.repeat(257) + ' https://x.com/'), 281)
    assert.equal(xWeightedLength('a'.repeat(256) + ' https://x.com/'), 280)
  })
})
