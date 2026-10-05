/**
 * Drafts shaped exactly like Track B's real generator sends them
 * (worker/src/loops/generator.ts, worker/src/generator/validators.ts on main):
 *
 *  - validation_errors items are {rule, message, field?}, and every draft
 *    with a digit carries a "contains_figures" item;
 *  - figures are re-extracted from the text, all "unverified", repeated once
 *    per text they appear in;
 *  - card.keyword and card.subline are always strings;
 *  - article is an untyped object (or null) and launch is never sent;
 *  - variants[].platform is a free string in its JSON schema.
 *
 * The route must store these drafts, never 422 the whole batch.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PGlite } from '@electric-sql/pglite'
import { migratedDb } from '../../testing/pglite-db.ts'
import { createFakeSupabase } from '../../testing/fake-supabase.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { routeFetch } from '../../testing/route-fetch.ts'
import { brandId, createAccount, resetSocial, rows } from '../../testing/social-fixtures.ts'
import { WorkerApi } from '../fake/worker-api-client.ts'

const TOKEN = 'compat-test-token-0123456789abcdefghij'
let db: PGlite
let brand: string
let api: WorkerApi

const figure = (value: string, context: string) => ({ value, context, source: 'unverified' })

function trackBDraft(ref: string, extra: Record<string, unknown> = {}) {
  return {
    client_ref: ref,
    kind: 'social',
    title: null,
    canonical_text: 'Ai pana pe 25 mai sa depui Declaratia Unica. Impozitul este 10%.',
    source_url: null,
    variants: [
      { platform: 'x', text: 'Termenul pentru Declaratia Unica este 25 mai. Impozitul: 10%.', settings: {} },
      { platform: 'linkedin-page', text: 'Declaratia Unica se depune pana pe 25 mai.', settings: {} },
    ],
    article: null,
    card: {
      template: 'dark',
      headline: 'Declaratia Unica pana pe 25 mai',
      keyword: '25 mai',
      stat: '25 mai',
      subline: 'Afla ce trebuie sa depui si cand.',
      brand: 'taxes-support',
      alt_text: 'Card cu termenul de 25 mai',
    },
    figures: [
      figure('10%', 'Impozitul este 10%.'),
      figure('25 mai', 'pana pe 25 mai sa depui'),
      figure('25 mai', 'Unica este 25 mai. Impo'),
      figure('25 mai', 'se depune pana pe 25 mai.'),
    ],
    validation_errors: [
      { rule: 'contains_figures', message: 'Post contains figures that need manual verification' },
      { rule: 'contains_figures', message: 'Post contains figures that need manual verification', field: 'variants.x' },
      { rule: 'length', message: 'Text exceeds x limit of 280 chars (got 301)', field: 'variants.x' },
    ],
    notes: null,
    ...extra,
  }
}

describe('drafts from the Track B generator are accepted', () => {
  before(async () => {
    db = await migratedDb()
    setTestAdminClient(createFakeSupabase(db))
    brand = await brandId(db)
    api = new WorkerApi({ baseUrl: 'http://127.0.0.1:3000', token: TOKEN, workerId: 'worker-local-01', fetch: routeFetch })
  })
  after(async () => {
    setTestAdminClient(null)
    await db.close()
  })
  beforeEach(async () => {
    process.env.WORKER_TOKEN = TOKEN
    await resetSocial(db)
    await createAccount(db, brand, 'x')
    await createAccount(db, brand, 'linkedin-page')
    await rows(db, `insert into social_generation_requests (brand_id, input) values ($1, $2)`, [
      brand,
      JSON.stringify({ source: { type: 'topic', topic: 'Declaratia Unica', hooks: [] }, platforms: ['x', 'linkedin-page'], kinds: ['social'], count: 3, language: 'ro', templates: ['dark'] }),
    ])
  })

  async function deliver(drafts: unknown[]) {
    const claim = await api.post<{ requests: Array<{ request_id: string }> }>('/generation/claim', { limit: 1 })
    const id = claim.body.requests[0].request_id
    return api.post(`/generation/${id}/drafts`, { drafts })
  }

  it('stores {rule, message, field} errors with the rule as the code', async () => {
    const r = await deliver([trackBDraft('1')])
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.deepEqual(r.body, { created: 1, skipped: 0 })
    const [rev] = await rows(db, `select generator_errors, figures from social_post_revisions`)
    assert.deepEqual(rev.generator_errors.map((e: { code: string }) => e.code), ['contains_figures', 'contains_figures', 'length'])
    assert.equal(rev.generator_errors[2].field, 'variants.x')
    assert.equal(rev.figures.length, 4, 'figures are stored as sent, duplicates included')
  })

  it('keeps a draft whose variant names a platform outside the contract, without a destination for it', async () => {
    const draft = trackBDraft('1', {
      variants: [
        { platform: 'x', text: 'Termenul este 25 mai.', settings: {} },
        { platform: 'linkedin', text: 'Varianta cu un nume de platforma gresit.', settings: {} },
      ],
    })
    const r = await deliver([draft])
    assert.equal(r.status, 200, JSON.stringify(r.body))
    const dests = await rows(db, `select platform from social_destinations`)
    assert.deepEqual(dests.map((d) => d.platform), ['x'])
    const [rev] = await rows(db, `select notes, variants from social_post_revisions`)
    assert.match(rev.notes, /linkedin/)
    assert.equal(rev.variants.length, 2)
  })

  it('accepts an article object with other keys than the contract names, and no launch', async () => {
    const r = await deliver([trackBDraft('1', { kind: 'social', article: { headline: 'x', body: 'y' } })])
    assert.equal(r.status, 200, JSON.stringify(r.body))
  })

  it('accepts a long list of repeated figures', async () => {
    const many = Array.from({ length: 150 }, (_, i) => figure(`${i}%`, 'context'))
    const r = await deliver([trackBDraft('1', { figures: many })])
    assert.equal(r.status, 200, JSON.stringify(r.body))
  })
})
