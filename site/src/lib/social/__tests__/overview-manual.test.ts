import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PGlite } from '@electric-sql/pglite'
import { migratedDb } from '../../testing/pglite-db.ts'
import { createFakeSupabase } from '../../testing/fake-supabase.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { setTestAdmin } from '../../testing/auth-shim.ts'
import { routeFetch } from '../../testing/route-fetch.ts'
import { adminUser, brandId, createAccount, resetSocial, rows, scheduleAndApprove } from '../../testing/social-fixtures.ts'
import { WorkerApi } from '../fake/worker-api-client.ts'
import { runFakeWorkerOnce, syncFakeAccounts } from '../fake/fake-worker.ts'
import { createManualAccount, updateAccount } from '../accounts-actions.ts'
import { duplicatePost, markManualPublished } from '../handoff-actions.ts'
import { getManualJob, listManualJobs } from '../handoff-queries.ts'
import { getOverview, listEvents } from '../overview-queries.ts'
import { markEventsSeen } from '../overview-actions.ts'
import { getCalendarWeek } from '../calendar-queries.ts'
import { mondayOf } from '../calendar.ts'
import { bucharestDay } from '../time.ts'
import { approvalHash, destinationHash } from '../hash.ts'

const TOKEN = 'overview-test-token-0123456789abcdef'
let db: PGlite
let brand: string
let admin: { userId: string; email: string }
let api: WorkerApi
async function draft(accounts: string[], extra: { scheduledAt?: string; kind?: string; article?: Record<string, unknown>; media?: string } = {}) {
  const [{ id }] = await rows(db, `select social_create_post($1::jsonb, $2::jsonb, $3::jsonb) as id`, [
    JSON.stringify({ brand_id: brand, kind: extra.kind ?? 'social', title: 'Titlu test', source_url: 'https://example.test/article', created_by: admin.userId }),
    JSON.stringify({ canonical_text: 'Salut', article: extra.article ?? null, figures: [{ value: '2026', source: 'confirmed', confirmed_by: admin.email, confirmed_at: new Date().toISOString() }], card_spec: { headline: 'Titlu' } }),
    JSON.stringify(accounts.map((id) => ({ account_id: id, text: extra.kind === 'article' ? '# Articol\n\nContinut **bun**.' : 'Salut', settings: extra.kind === 'article' ? { title: 'Titlu articol', subtitle: 'Subtitlu' } : {}, scheduled_at: extra.scheduledAt ?? null, media: extra.media ? [{ media_id: extra.media, position: 0, alt_text: 'Imagine de test' }] : [] }))),
  ])
  return id as string
}

describe('overview, manual handoff and duplicate (W3)', () => {
  before(async () => {
    db = await migratedDb(); setTestAdminClient(createFakeSupabase(db))
    brand = await brandId(db); admin = { userId: await adminUser(db), email: 'admin@example.test' }
    api = new WorkerApi({ baseUrl: 'http://127.0.0.1:3000', token: TOKEN, workerId: 'overview-worker', fetch: routeFetch })
  })
  after(async () => { setTestAdminClient(null); setTestAdmin(null); await db.close() })
  beforeEach(async () => {
    await resetSocial(db); setTestAdmin(admin)
    process.env.WORKER_TOKEN = TOKEN; process.env.SOCIAL_PUBLISHING_ENABLED = 'true'
  })
  it('refuses manual completion, duplicate and event marking without admin, without writing', async () => {
    const account = await createAccount(db, brand, 'substack')
    const post = await draft([account]); const { jobs } = await scheduleAndApprove(db, post, admin.userId)
    await rows(db, `insert into social_events(type) values ('manual_due')`)
    setTestAdmin(null)
    assert.equal((await markManualPublished(jobs[0], 'https://example.test/published')).ok, false)
    assert.equal((await duplicatePost(post)).ok, false)
    assert.equal((await markEventsSeen({ upTo: 99999 })).ok, false)
    assert.equal((await rows(db, `select status from social_delivery_jobs`))[0].status, 'manual_pending')
    assert.equal((await rows(db, `select count(*)::int n from social_posts`))[0].n, 1)
    assert.equal((await rows(db, `select seen_at from social_events`))[0].seen_at, null)
    assert.equal((await rows(db, `select * from social_activity_log`)).length, 0)
  })
  it('syncs, manages X and Substack, publishes automatically and completes the manual handoff', async () => {
    assert.equal((await syncFakeAccounts(api)).status, 200)
    const [x] = await rows(db, `select id from social_accounts where postiz_integration_id = 'fake-x'`)
    assert.equal((await updateAccount(x.id, { brand_id: brand, paused: false })).ok, true)
    const created = await createManualAccount({ brandId: brand, displayName: 'Publication test', platform: 'substack', openEditorUrl: 'https://example.test/editor' })
    assert.equal(created.ok, true); if (!created.ok) return
    const [{ id: media }] = await rows(db, `insert into social_media(storage_path, sha256, mime, width, height, bytes, alt_text, source) values ('test/image.png', repeat('a',64), 'image/png',1080,1080,100,'Imagine de test','upload') returning id`)
    const article = await draft([created.accountId], { kind: 'article', article: { title: 'Titlu articol', subtitle: 'Subtitlu', body_markdown: '# Articol\n\nContinut **bun**.' }, media })
    const automatic = await draft([x.id])
    const manualApproval = await scheduleAndApprove(db, article, admin.userId)
    const autoApproval = await scheduleAndApprove(db, automatic, admin.userId)
    const steps = await runFakeWorkerOnce(api, { scenario: 'ok' })
    assert.deepEqual(steps.map((s) => s.status), [200, 200])
    assert.equal((await listEvents()).events.filter((e) => e.type === 'manual_due').length, 1)
    const handoff = await getManualJob(manualApproval.jobs[0])
    assert.ok(handoff); assert.equal(handoff.due, true)
    assert.equal(handoff.account.open_editor_url, 'https://example.test/editor')
    assert.equal(handoff.handoff.fields[0].value, 'Titlu articol')
    assert.match(handoff.handoff.body.html, /<strong>bun<\/strong>/)
    assert.equal(handoff.media[0].alt_text, 'Imagine de test'); assert.ok(handoff.media[0].url)
    assert.equal((await listManualJobs()).pending[0].post?.id, article)
    assert.equal((await markManualPublished(manualApproval.jobs[0], 'javascript:bad')).ok, false)
    const publishedUrl = 'https://example.test/public/article'
    assert.deepEqual(await markManualPublished(manualApproval.jobs[0], publishedUrl), { ok: true, alreadyDone: false })
    assert.deepEqual(await markManualPublished(manualApproval.jobs[0], publishedUrl), { ok: true, alreadyDone: true })
    assert.equal((await rows(db, `select status from social_posts where id=$1`, [article]))[0].status, 'published')
    const finished = await getManualJob(manualApproval.jobs[0])
    assert.equal(finished?.job.remote_url, publishedUrl); assert.equal(finished?.manual_done_by_email, admin.email)
    assert.equal((await listManualJobs()).done.length, 1)
    await rows(db, `update social_delivery_jobs set next_check_at=now() where id=$1`, [autoApproval.jobs[0]])
    await runFakeWorkerOnce(api)
    const overview = await getOverview()
    assert.equal(overview.manualDue.length, 0); assert.equal(overview.worker.seen, 'ok')
    assert.equal(overview.today.find((j) => j.post?.id === article)?.remote_url, publishedUrl)
    assert.match(overview.today.find((j) => j.post?.id === automatic)?.remote_url ?? '', /example.com\/fake\/x/)
    const week = await getCalendarWeek(mondayOf(bucharestDay(new Date())))
    assert.equal(week.total, 2)
    assert.equal(week.days.flatMap((d) => d.entries).find((e) => e.post_id === article)?.remote_url, publishedUrl)
    assert.equal((await listEvents()).events.filter((e) => e.type === 'manual_due').length, 1, 'sweep emits due once')
  })
  it('event marking is scoped to visible ids or the displayed watermark and is idempotent', async () => {
    const inserted = await rows(db, `insert into social_events(type) values ('drafts_ready'),('generation_failed'),('worker_silent') returning id`)
    assert.equal((await listEvents()).unseen, 3)
    assert.deepEqual(await markEventsSeen({ ids: [Number(inserted[1].id)] }), { ok: true, marked: 1 })
    assert.deepEqual(await markEventsSeen({ ids: [Number(inserted[1].id)] }), { ok: true, marked: 0 })
    assert.deepEqual(await markEventsSeen({ upTo: Number(inserted[1].id) }), { ok: true, marked: 1 })
    assert.equal((await listEvents()).unseen, 1)
    assert.equal((await listEvents({ includeSeen: true })).events.length, 3)
    assert.equal((await rows(db, `select seen_by from social_events where id=$1`, [inserted[0].id]))[0].seen_by, admin.userId)
    assert.equal((await markEventsSeen({ upTo: Infinity })).ok, false)
    assert.equal((await markEventsSeen({ ids: [] })).ok, false)
  })
  it('overview groups drafts, failures, future jobs, due manual work and reconnect accounts', async () => {
    const x = await createAccount(db, brand, 'x'); const sub = await createAccount(db, brand, 'substack')
    const queue = await draft([x])
    const upcoming = await draft([x]); await scheduleAndApprove(db, upcoming, admin.userId, new Date(Date.now() + 24 * 3600_000))
    const failure = await draft([x]); const { jobs } = await scheduleAndApprove(db, failure, admin.userId)
    await rows(db, `update social_delivery_jobs set status='failed', last_error_code='TEST' where id=$1`, [jobs[0]])
    const manual = await draft([sub]); await scheduleAndApprove(db, manual, admin.userId)
    await updateAccount(x, { status: 'reconnect_required' })
    const data = await getOverview()
    assert.ok(data.approvalQueue.some((d) => d.id === queue)); assert.ok(data.failures.some((j) => j.post?.id === failure))
    assert.ok(data.upcoming.some((j) => j.post?.id === upcoming)); assert.equal(data.nextScheduled?.post?.id, upcoming)
    assert.ok(data.manualDue.some((j) => j.post?.id === manual)); assert.ok(data.attention.some((a) => a.id === x))
    assert.ok(data.events.some((e) => e.type === 'manual_due'))
  })
  it('calendar keeps only current draft slots and handles DST weeks and cancelled jobs', async () => {
    for (const [monday, instant, hours] of [['2026-10-19','2026-10-25T00:30:00Z',25], ['2026-03-23','2026-03-29T00:30:00Z',23]] as const) {
      await resetSocial(db)
      const x = await createAccount(db, brand, 'x')
      const current = await draft([x], { scheduledAt: instant }); const old = await draft([x], { scheduledAt: instant })
      const [p] = await rows(db, `select current_revision_id from social_posts where id=$1`, [old])
      await rows(db, `select social_save_revision($1,$2,$3,'{}'::jsonb,$4::jsonb,'test edit')`, [old, p.current_revision_id, admin.userId, JSON.stringify([{ account_id:x,text:'Actualizat',settings:{}, scheduled_at:null }])])
      const cancelled = await draft([x]); const approval = await scheduleAndApprove(db, cancelled, admin.userId, new Date(instant))
      await rows(db, `update social_delivery_jobs set status='cancelled' where id=$1`, [approval.jobs[0]])
      const week = await getCalendarWeek(monday)
      assert.equal(week.days[6].hours, hours); assert.equal(week.total, 1)
      assert.equal(week.days[6].entries[0].post_id, current); assert.equal(week.days[6].entries[0].kind, 'draft')
      assert.equal((await getCalendarWeek(monday, { cancelled:true })).total, 2)
    }
  })
  it('duplicates content, settings, figures and media as an unscheduled unapproved draft', async () => {
    const sub = await createAccount(db, brand, 'substack'); const x = await createAccount(db, brand, 'x')
    const [{ id: media }] = await rows(db, `insert into social_media(storage_path,sha256,mime,width,height,bytes,alt_text,source) values ('test/copy.png',repeat('b',64),'image/png',1080,1080,100,'Imagine de test','upload') returning id`)
    const post = await draft([sub, x], { kind: 'article', article: { body_markdown:'Corp' }, media, scheduledAt: new Date(Date.now() - 5_000).toISOString() })
    // Approve the existing revision: the generic schedule fixture intentionally creates a content-empty revision.
    const [source] = await rows(db, `select current_revision_id from social_posts where id=$1`, [post])
    const sourceDestinations = await rows(db, `select * from social_destinations where revision_id=$1`, [source.current_revision_id])
    const hashes = sourceDestinations.map((d) => ({ id: d.id as string, destination_hash: destinationHash({ account_id:d.account_id, platform:d.platform, text:d.text, settings:d.settings, scheduled_at:d.scheduled_at, media:[{ sha256:'b'.repeat(64), alt_text:'Imagine de test' }] }) }))
    await rows(db, `select social_approve_revision($1,$2,$3,$4,$5,true,$6::jsonb,now()-interval '1 minute')`, [post,source.current_revision_id,admin.userId,admin.email,approvalHash({ post_id:post,revision_id:source.current_revision_id,destinations:hashes }),JSON.stringify(hashes)])
    await rows(db, `update social_delivery_jobs set status='published' where account_id=$1`, [x])
    assert.equal((await updateAccount(x, { brand_id:await brandId(db, 'comets-of-web3') })).ok, true)
    const copied = await duplicatePost(post)
    assert.equal(copied.ok, true, JSON.stringify(copied)); if (!copied.ok) return
    assert.equal(copied.dropped, 1); assert.notEqual(copied.postId, post)
    const [p] = await rows(db, `select * from social_posts where id=$1`, [copied.postId])
    assert.equal(p.status, 'draft'); assert.equal(p.title, 'Titlu test (copie)'); assert.equal(p.source_url, 'https://example.test/article')
    const [revision] = await rows(db, `select * from social_post_revisions where id=$1`, [p.current_revision_id])
    assert.equal(revision.article.body_markdown, 'Corp'); assert.equal(revision.figures[0].source, 'confirmed')
    const dest = await rows(db, `select * from social_destinations where revision_id=$1`, [revision.id])
    assert.equal(dest.length, 1); assert.equal(dest[0].scheduled_at, null); assert.equal(dest[0].settings.title, 'Titlu articol')
    assert.equal((await rows(db, `select media_id from social_destination_media where destination_id=$1`, [dest[0].id]))[0].media_id, media)
    assert.equal((await rows(db, `select * from social_approvals where revision_id=$1`, [revision.id])).length, 0)
    assert.equal((await rows(db, `select * from social_delivery_jobs where destination_id=$1`, [dest[0].id])).length, 0)
    assert.equal((await rows(db, `select * from social_activity_log where action='social.post_duplicated'`)).length, 1)
    assert.equal((await duplicatePost('bad-id')).ok, false)
  })
})
