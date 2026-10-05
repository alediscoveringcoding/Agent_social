/**
 * The drafting flow (PRD F2 / A5, editing half of F4) through the real server
 * actions and queries, on PGlite, with the generator side played by the fake
 * generator through the real worker API.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PGlite } from '@electric-sql/pglite'
import { migratedDb } from '../../testing/pglite-db.ts'
import { createFakeSupabase } from '../../testing/fake-supabase.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { setTestAdmin } from '../../testing/auth-shim.ts'
import { routeFetch } from '../../testing/route-fetch.ts'
import { adminUser, brandId, createAccount, resetSocial, rows } from '../../testing/social-fixtures.ts'
import { WorkerApi } from '../fake/worker-api-client.ts'
import { runFakeGeneratorOnce } from '../fake/fake-generator.ts'
import { createGenerationRequest, discardDraft, saveDraft } from '../actions.ts'
import { getDraft, listDrafts, listGenerationRequests } from '../queries.ts'
import type { DraftDetail } from '../queries.ts'
import { reconcileFigures, sanitizeSettings, DraftEditError } from '../draft-edit.ts'

const TOKEN = 'drafting-test-token-0123456789abcdef'
let db: PGlite
let brand: string
let admin: { userId: string; email: string }
let api: WorkerApi

function editFrom(d: DraftDetail) {
  return {
    title: d.title,
    canonicalText: d.revision.canonical_text,
    figures: d.revision.figures,
    destinations: d.destinations.map((x) => ({ accountId: x.account_id, text: x.text, settings: x.settings })),
  }
}

async function generate(platforms: string[], count: number) {
  const r = await createGenerationRequest({
    brandId: brand,
    source: { type: 'topic', topic: 'Declaratia Unica', hooks: ['deadline'] },
    platforms: platforms as never,
    count,
    templates: ['dark'],
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  await runFakeGeneratorOnce(api)
}

describe('drafting flow: actions and queries', () => {
  before(async () => {
    db = await migratedDb()
    setTestAdminClient(createFakeSupabase(db))
    brand = await brandId(db)
    admin = { userId: await adminUser(db), email: 'admin@example.test' }
    api = new WorkerApi({ baseUrl: 'http://127.0.0.1:3000', token: TOKEN, workerId: 'gen-1', fetch: routeFetch })
  })
  after(async () => {
    setTestAdminClient(null)
    setTestAdmin(null)
    await db.close()
  })
  beforeEach(async () => {
    process.env.WORKER_TOKEN = TOKEN
    delete process.env.SOCIAL_LEGAL_NAMES
    setTestAdmin(admin)
    await resetSocial(db)
  })

  it('refuses every action without an admin session', async () => {
    setTestAdmin(null)
    const r = await createGenerationRequest({ brandId: brand, source: { type: 'topic', topic: 'x y z', hooks: [] }, platforms: ['x'], count: 1, templates: ['dark'] })
    assert.equal(r.ok, false)
    assert.match((r as { error: string }).error, /cod/)
    assert.equal((await discardDraft('00000000-0000-4000-8000-000000000000')).ok, false)
    assert.equal((await rows(db, `select 1 from social_generation_requests`)).length, 0)
  })

  it('creates a generation request with the PRD 10.5 input and logs it', async () => {
    const r = await createGenerationRequest({
      brandId: brand,
      source: { type: 'article', url: 'https://thecrypto.support/ghid/impozit' },
      platforms: ['x', 'devto', 'producthunt'],
      count: 3,
      templates: ['mint'],
    })
    assert.equal(r.ok, true)
    const [g] = await rows(db, `select input, requested_by, status from social_generation_requests`)
    assert.deepEqual(g.input, {
      source: { type: 'article', url: 'https://thecrypto.support/ghid/impozit' },
      platforms: ['x', 'devto', 'producthunt'],
      kinds: ['social', 'article', 'launch'],
      count: 3,
      language: 'ro',
      templates: ['mint'],
    })
    assert.equal(g.requested_by, admin.userId)
    assert.equal(g.status, 'queued')
    const [log] = await rows(db, `select action, actor_email from social_activity_log`)
    assert.deepEqual(log, { action: 'social.generation_requested', actor_email: 'admin@example.test' })
    const listed = await listGenerationRequests()
    assert.equal(listed[0].brand?.slug, 'taxes-support')
    assert.equal(listed[0].requested_by_email, 'admin@example.test')
  })

  it('rejects bad form input with a readable message', async () => {
    const bad = (over: object) =>
      createGenerationRequest({ brandId: brand, source: { type: 'topic', topic: 'Subiect', hooks: [] }, platforms: ['x'], count: 2, templates: ['dark'], ...over })
    assert.match(((await bad({ platforms: [] })) as { error: string }).error, /platforma/)
    assert.match(((await bad({ count: 21 })) as { error: string }).error, /1 si 20/)
    assert.match(((await bad({ source: { type: 'article', url: 'ftp://x' } })) as { error: string }).error, /https/)
    assert.match(((await bad({ brandId: '00000000-0000-4000-8000-000000000000' })) as { error: string }).error, /brand/)
  })

  it('lists generator drafts with their rule violations', async () => {
    for (const p of ['x', 'instagram', 'linkedin-page', 'facebook']) await createAccount(db, brand, p)
    await generate(['x', 'instagram', 'linkedin-page', 'facebook'], 6)
    const drafts = await listDrafts()
    assert.equal(drafts.length, 6)
    const codes = new Set(drafts.flatMap((d) => d.destinations.flatMap((x) => x.errors)))
    for (const c of ['DIACRITICS', 'UNVERIFIED_FIGURE', 'TOO_LONG', 'BANNED_PHRASE', 'IG_URL']) assert.ok(codes.has(c), c)
    const unverified = drafts.find((d) => d.unverified_figures > 0)
    assert.ok(unverified)
    assert.ok(drafts.every((d) => d.revision?.number === 1 && d.brand?.slug === 'taxes-support'))
  })

  it('saving fixes violations in a new revision, keeps the old one, and logs it', async () => {
    await createAccount(db, brand, 'x')
    await createAccount(db, brand, 'linkedin-page')
    await generate(['x', 'linkedin-page'], 4)
    const tooLong = (await listDrafts()).find((d) => d.destinations.some((x) => x.errors.includes('TOO_LONG')))!
    const detail = (await getDraft(tooLong.id))!
    const edit = editFrom(detail)
    edit.destinations = edit.destinations.map((d) =>
      detail.destinations.find((x) => x.account_id === d.accountId)?.platform === 'x' ? { ...d, text: 'Lista de documente pentru declaratie, pe scurt.' } : d
    )
    const r = await saveDraft({ postId: tooLong.id, baseRevisionId: detail.revision.id, edit })
    assert.equal(r.ok, true, JSON.stringify(r))
    const after = (await getDraft(tooLong.id))!
    assert.equal(after.revision.number, 2)
    assert.equal(after.revisions.length, 2)
    assert.equal(after.revisions[0].created_by_email, 'admin@example.test')
    assert.ok(after.destinations.every((d) => d.validation.ok), JSON.stringify(after.destinations.map((d) => d.validation.errors)))
    const [log] = await rows(db, `select action, post_id from social_activity_log where action = 'social.draft_saved'`)
    assert.equal(log.post_id, tooLong.id)
  })

  it('confirming an unverified figure clears UNVERIFIED_FIGURE and records who', async () => {
    await createAccount(db, brand, 'linkedin-page')
    await createAccount(db, brand, 'x')
    await generate(['linkedin-page', 'x'], 3)
    const d = (await listDrafts()).find((x) => x.unverified_figures > 0)!
    const detail = (await getDraft(d.id))!
    const edit = editFrom(detail)
    edit.figures = detail.revision.figures.map((f) => ({ ...f, source: 'confirmed' }))
    assert.equal((await saveDraft({ postId: d.id, baseRevisionId: detail.revision.id, edit })).ok, true)
    const after = (await getDraft(d.id))!
    assert.ok(after.revision.figures.every((f) => f.source === 'confirmed' && f.confirmed_by === 'admin@example.test'))
    assert.ok(after.destinations.every((x) => !(x.validation.errors ?? []).some((e) => e.code === 'UNVERIFIED_FIGURE')))
  })

  it('refuses relabelling an unverified figure as a source, and a stale base revision', async () => {
    await createAccount(db, brand, 'linkedin-page')
    await generate(['linkedin-page'], 3)
    const d = (await listDrafts()).find((x) => x.unverified_figures > 0)!
    const detail = (await getDraft(d.id))!
    const edit = editFrom(detail)
    const relabel = await saveDraft({
      postId: d.id,
      baseRevisionId: detail.revision.id,
      edit: { ...edit, figures: detail.revision.figures.map((f) => ({ ...f, source: 'facts' })) },
    })
    assert.equal(relabel.ok, false)
    assert.match((relabel as { error: string }).error, /nu se poate schimba/)

    assert.equal((await saveDraft({ postId: d.id, baseRevisionId: detail.revision.id, edit })).ok, true)
    const stale = await saveDraft({ postId: d.id, baseRevisionId: detail.revision.id, edit })
    assert.equal(stale.ok, false)
    assert.match((stale as { error: string }).error, /salvata intre timp/)
  })

  it('turns a draft into a post for the chosen accounts: add one, drop one', async () => {
    const x = await createAccount(db, brand, 'x')
    await createAccount(db, brand, 'facebook')
    const fb = (await rows(db, `select id from social_accounts where platform = 'facebook'`))[0].id
    await generate(['x'], 1)
    const [d] = await listDrafts()
    const detail = (await getDraft(d.id))!
    assert.deepEqual(detail.destinations.map((x) => x.platform), ['x'])
    assert.equal(detail.accounts.length, 2)
    const r = await saveDraft({
      postId: d.id,
      baseRevisionId: detail.revision.id,
      edit: { ...editFrom(detail), destinations: [{ accountId: fb, text: 'Varianta pentru Facebook, scrisa de mana.', settings: { sneaky: 'dropped' } }] },
    })
    assert.equal(r.ok, true, JSON.stringify(r))
    const after = (await getDraft(d.id))!
    assert.deepEqual(after.destinations.map((x) => [x.platform, x.settings]), [['facebook', {}]])
    assert.ok(!after.destinations.some((y) => y.account_id === x))
  })

  it('refuses an account of another brand and an empty platform list', async () => {
    await createAccount(db, brand, 'x')
    const other = await createAccount(db, await brandId(db, 'comets-of-web3'), 'x')
    await generate(['x'], 1)
    const [d] = await listDrafts()
    const detail = (await getDraft(d.id))!
    const foreign = await saveDraft({ postId: d.id, baseRevisionId: detail.revision.id, edit: { ...editFrom(detail), destinations: [{ accountId: other, text: 'x', settings: {} }] } })
    assert.equal(foreign.ok, false)
    const none = await saveDraft({ postId: d.id, baseRevisionId: detail.revision.id, edit: { ...editFrom(detail), destinations: [] } })
    assert.match((none as { error: string }).error, /cel putin o platforma/)
  })

  it('discarding a draft removes it from the inbox and logs it', async () => {
    await createAccount(db, brand, 'x')
    await generate(['x'], 2)
    const [first] = await listDrafts()
    assert.equal((await discardDraft(first.id)).ok, true)
    assert.equal((await listDrafts()).length, 1)
    assert.equal((await rows(db, `select status from social_posts where id = $1`, [first.id]))[0].status, 'cancelled')
    assert.equal((await rows(db, `select 1 from social_activity_log where action = 'social.draft_discarded'`)).length, 1)
    assert.equal((await discardDraft(first.id)).ok, false)
  })
})

describe('draft edit rules (pure)', () => {
  it('keeps only the neutral settings of the platform', () => {
    assert.deepEqual(sanitizeSettings('x', { who_can_reply: 'everyone', evil: 1 }), { who_can_reply: 'everyone' })
    assert.deepEqual(sanitizeSettings('devto', { title: 'T', tags: 'a, b ,', canonical_url: 'https://thecrypto.support/x' }), {
      title: 'T',
      tags: ['a', 'b'],
      canonical_url: 'https://thecrypto.support/x',
    })
    assert.deepEqual(sanitizeSettings('facebook', { anything: 'x' }), {})
  })

  it('lets a person confirm, un-confirm, add or drop figures, nothing else', () => {
    const now = new Date('2026-10-05T10:00:00Z')
    const base = [{ value: '600 lei', source: 'unverified' }, { value: '16%', source: 'facts' }]
    const ok = reconcileFigures(base, [{ value: '600 lei', source: 'confirmed' }, { value: '25 mai', source: 'confirmed' }], 'a@example.test', now)
    assert.deepEqual(ok.map((f) => [f.value, f.source, f.confirmed_by]), [
      ['600 lei', 'confirmed', 'a@example.test'],
      ['25 mai', 'confirmed', 'a@example.test'],
    ])
    assert.throws(() => reconcileFigures(base, [{ value: '600 lei', source: 'article' }], 'a', now), DraftEditError)
    assert.throws(() => reconcileFigures(base, [{ value: '1 000', source: 'facts' }], 'a', now), DraftEditError)
    assert.throws(() => reconcileFigures(base, [{ value: '16%', source: 'unverified' }], 'a', now), DraftEditError)
  })
})
