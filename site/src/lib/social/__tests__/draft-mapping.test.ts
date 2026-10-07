import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mapDraft, type BrandAccount } from '../draft-mapping.ts'
import { DraftSchema } from '../schemas.ts'
import { becameReconnectRequired, platformForProvider, syncedStatus } from '../sync-rules.ts'

const accounts: BrandAccount[] = [
  { id: 'acc-x', platform: 'x', display_name: 'X' },
  { id: 'acc-ig', platform: 'instagram', display_name: 'IG' },
  { id: 'acc-dev', platform: 'devto', display_name: 'dev.to' },
]

/** The PRD 10.5 example, as the generator would send it. */
const prdDraft = DraftSchema.parse({
  client_ref: '1',
  kind: 'social',
  title: null,
  canonical_text: 'Impozitul pe castigurile crypto creste la 16%.',
  source_url: 'https://thecrypto.support/ghid/impozit',
  variants: [
    { platform: 'x', text: 'Impozitul pe castiguri crypto: 16% din 2026.', settings: {} },
    { platform: 'instagram', text: 'Ce se schimba din 2026. Detalii in bio.', settings: { post_type: 'post' } },
    { platform: 'linkedin-page', text: 'Pentru LinkedIn', settings: {} },
  ],
  article: null,
  card: {
    template: 'dark',
    headline: 'Impozitul pe castigurile crypto creste',
    keyword: 'creste',
    stat: '16%',
    subline: 'Din anul fiscal 2026. Afla ce inseamna pentru tine.',
    brand: 'the-crypto-support',
    alt_text: 'Card',
  },
  figures: [{ value: '16%', context: 'impozit pe castig din anul fiscal 2026', source: 'facts' }],
  validation_errors: [],
  notes: 'Short note for the reviewer',
})

describe('mapDraft', () => {
  it('makes one destination per brand account of each variant platform', () => {
    const m = mapDraft(prdDraft, accounts)
    assert.deepEqual(m.destinations.map((d) => d.account_id), ['acc-x', 'acc-ig'])
    assert.deepEqual(m.unmatchedPlatforms, ['linkedin-page'])
    assert.match(m.revision.notes ?? '', /linkedin-page/)
    assert.equal(m.revision.variants.length, 3, 'unmatched variants are kept on the revision')
  })

  it('fills neutral settings and keeps figures on every destination', () => {
    const m = mapDraft(prdDraft, accounts)
    const x = m.destinations.find((d) => d.platform === 'x')!
    assert.deepEqual(x.settings, { who_can_reply: 'everyone' })
    assert.equal(x.contains_figures, true)
    assert.deepEqual(x.figures, prdDraft.figures)
    assert.equal(m.destinations.find((d) => d.platform === 'instagram')!.figures.length, 1)
  })

  it('stores validation without the "no time yet" error, and flags real problems', () => {
    const m = mapDraft(prdDraft, accounts)
    const x = m.destinations.find((d) => d.platform === 'x')!
    assert.equal(x.validation.ok, true, JSON.stringify(x.validation.errors))
    const ig = m.destinations.find((d) => d.platform === 'instagram')!
    assert.deepEqual(ig.validation.errors.map((e) => e.code), ['IG_NO_IMAGE'])
  })

  it('turns an article into dev.to settings with the source as canonical URL', () => {
    const article = DraftSchema.parse({
      client_ref: '2',
      kind: 'article',
      canonical_text: 'Rezumat',
      source_url: 'https://thecrypto.support/ghid/a',
      variants: [{ platform: 'devto', text: '' }],
      article: { title: 'Ghid', subtitle: 'Sub', body_markdown: '# Ghid\n\nText', tags: ['crypto', 'taxe'] },
    })
    const m = mapDraft(article, accounts)
    assert.equal(m.post.title, 'Ghid')
    const dev = m.destinations[0]
    assert.equal(dev.text, '# Ghid\n\nText')
    assert.deepEqual(dev.settings, {
      title: 'Ghid',
      tags: ['crypto', 'taxe'],
      canonical_url: 'https://thecrypto.support/ghid/a',
    })
    assert.equal(dev.validation.ok, true, JSON.stringify(dev.validation.errors))
  })

  it('drops non-http(s) links instead of storing them or rejecting the batch', () => {
    for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', '/ghid/a', '//evil.test/a', '']) {
      const d = DraftSchema.parse({
        ...prdDraft,
        source_url: bad,
        article: { title: 'T', body_markdown: 'B', canonical_url: bad },
      })
      assert.equal(d.source_url, null, bad)
      assert.equal(d.article?.canonical_url, null, bad)
    }
    const ok = DraftSchema.parse({ ...prdDraft, source_url: ' https://thecrypto.support/ghid/a ' })
    assert.equal(ok.source_url, 'https://thecrypto.support/ghid/a')
  })

  it('keeps the generator validation errors for the reviewer', () => {
    const bad = DraftSchema.parse({
      ...prdDraft,
      client_ref: '3',
      validation_errors: ['diacritice in text', { code: 'TOO_LONG', message: 'X prea lung' }],
    })
    assert.deepEqual(mapDraft(bad, accounts).revision.generator_errors, [
      { message: 'diacritice in text' },
      { code: 'TOO_LONG', message: 'X prea lung' },
    ])
  })
})

describe('account sync rules', () => {
  it('maps Postiz providers, including their dotted spellings', () => {
    assert.equal(platformForProvider('instagram-standalone'), 'instagram')
    assert.equal(platformForProvider('linkedin.page'), 'linkedin-page')
    assert.equal(platformForProvider('dev.to'), 'devto')
    assert.equal(platformForProvider('vimeo'), null, 'a provider the app does not publish to is ignored')
    assert.equal(platformForProvider('tiktok-business'), 'tiktok')
  })

  it('lets Postiz decide reconnects, and nothing else', () => {
    assert.equal(syncedStatus(null, false), 'connected')
    assert.equal(syncedStatus('connected', true), 'reconnect_required')
    assert.equal(syncedStatus('reconnect_required', false), 'connected')
    assert.equal(syncedStatus('developer_setup_required', false), 'developer_setup_required')
    assert.equal(syncedStatus('approval_pending', false), 'approval_pending')
    assert.equal(syncedStatus('manual', true), 'manual')
  })

  it('notifies once, on the change', () => {
    assert.equal(becameReconnectRequired('connected', 'reconnect_required'), true)
    assert.equal(becameReconnectRequired('reconnect_required', 'reconnect_required'), false)
  })
})
