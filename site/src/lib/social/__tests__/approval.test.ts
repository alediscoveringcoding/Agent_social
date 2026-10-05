import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { migratedDb } from '../../testing/pglite-db.ts'
import { createFakeSupabase } from '../../testing/fake-supabase.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { setTestAdmin } from '../../testing/auth-shim.ts'
import { adminUser, brandId, createAccount, resetSocial, rows } from '../../testing/social-fixtures.ts'
import { routeFetch } from '../../testing/route-fetch.ts'
import { WorkerApi } from '../fake/worker-api-client.ts'
import { runFakeWorkerOnce } from '../fake/fake-worker.ts'
import { approvePost, reschedulePost, reopenForEdit, suggestTimes, cancelDestination, cancelPost, retryFailed } from '../approval-actions.ts'
import { getPost, isPostFilter, listPosts } from '../approval-queries.ts'
import { saveDraft } from '../actions.ts'
import { getDraft } from '../queries.ts'
import { localToInstant } from '../approval.ts'
import { toLocalInputs } from '../time.ts'

let db: PGlite
let brand: string
let admin: { userId: string; email: string }
const TOKEN = 'approval-test-token-0123456789abcdef'
const fakeId = '00000000-0000-4000-8000-000000000000'

async function draft(accounts: string[], text = 'Un ghid clar pentru documentele tale.', figures: object[] = []) {
  const [p] = await rows(db, 'select social_create_post($1::jsonb, $2::jsonb, $3::jsonb) as id', [
    JSON.stringify({ brand_id: brand, kind: 'social', title: 'Ghid', created_by: admin.userId }),
    JSON.stringify({ canonical_text: text, figures }),
    JSON.stringify(await Promise.all(accounts.map(async (account_id) => ({ account_id, text, settings: (await rows(db, 'select platform from social_accounts where id = $1', [account_id]))[0].platform === 'substack' ? { title: 'Ghid' } : {}, figures })))),
  ])
  return (await getPost(p.id))!
}
const tomorrow = () => toLocalInputs(new Date(Date.now() + 24 * 3600_000))
async function approve(post: Awaited<ReturnType<typeof draft>>, time = tomorrow(), figuresChecked = false) {
  return approvePost({ postId: post.id, revisionId: post.revision.id, times: Object.fromEntries(post.destinations.map((d) => [d.account_id, time])), figuresChecked })
}
function nextOctoberSunday() {
  let year = new Date().getUTCFullYear()
  for (;;) {
    const day = new Date(Date.UTC(year, 9, 31))
    day.setUTCDate(day.getUTCDate() - day.getUTCDay())
    if (day.getTime() > Date.now() + 24 * 3600_000) return day.toISOString().slice(0, 10)
    year++
  }
}

describe('approval actions on the real database', () => {
  before(async () => {
    db = await migratedDb()
    setTestAdminClient(createFakeSupabase(db))
    brand = await brandId(db)
    admin = { userId: await adminUser(db), email: 'admin@example.test' }
  })
  after(async () => { setTestAdminClient(null); setTestAdmin(null); await db.close() })
  beforeEach(async () => { await resetSocial(db); setTestAdmin(admin); process.env.WORKER_TOKEN = TOKEN; process.env.SOCIAL_PUBLISHING_ENABLED = 'true' })

  it('refuses every W1 action without admin and writes nothing (PRD 14.1)', async () => {
    setTestAdmin(null)
    const input = { postId: fakeId, revisionId: fakeId }
    for (const result of await Promise.all([
      approvePost({ ...input, figuresChecked: true }), reschedulePost(input), reopenForEdit(input), suggestTimes(input),
      cancelDestination({ postId: fakeId, jobId: fakeId }), cancelPost(input), retryFailed(input),
    ])) assert.equal(result.ok, false)
    for (const table of ['social_posts', 'social_approvals', 'social_delivery_jobs', 'social_activity_log']) {
      assert.equal((await rows(db, `select 1 from ${table}`)).length, 0, table)
    }
  })

  for (const action of ['reschedule', 'reopen'] as const) {
    it(`${action} revokes approval and cancels queued, claimed and manual jobs; approved rows are frozen (PRD 14.2)`, async () => {
      const accounts = await Promise.all(['x', 'facebook', 'substack'].map((platform) => createAccount(db, brand, platform)))
      let post = await draft(accounts)
      assert.equal((await approve(post)).ok, true)
      post = (await getPost(post.id))!
      const claimed = post.destinations.find((d) => d.platform === 'x')!.job!
      await db.query("update social_delivery_jobs set status = 'claimed', lease_owner = 'worker-test', lease_expires_at = now() + interval '10 min', lease_kind = 'publish' where id = $1", [claimed.id])
      await assert.rejects(db.query('update social_post_revisions set canonical_text = $1 where id = $2', ['Changed', post.revision.id]), /SOCIAL_REVISION_FROZEN/)
      await assert.rejects(db.query('update social_destinations set text = $1 where revision_id = $2', ['Changed', post.revision.id]), /SOCIAL_REVISION_FROZEN/)
      const result = action === 'reopen' ? await reopenForEdit({ postId: post.id, revisionId: post.revision.id }) :
        await reschedulePost({ postId: post.id, revisionId: post.revision.id, times: Object.fromEntries(accounts.map((id) => [id, toLocalInputs(new Date(Date.now() + 48 * 3600_000))])) })
      assert.equal(result.ok, true, JSON.stringify(result))
      const saved = (await getPost(post.id))!
      assert.notEqual(saved.revision.id, post.revision.id)
      assert.equal(saved.status, 'draft')
      assert.equal(saved.approval, null)
      assert.ok(saved.approvals[0].revoked_at)
      assert.equal((await rows(db, "select 1 from social_delivery_jobs where status = 'cancelled'")).length, 3)
      assert.equal((await rows(db, 'select 1 from social_delivery_jobs where lease_owner is not null')).length, 0)
    })
  }

  it('blocks unverified figures and the figures checkbox; saveDraft confirmation unblocks (PRD 14.3)', async () => {
    const account = await createAccount(db, brand)
    let post = await draft([account], 'Cota din exemplu este 16%.', [{ value: '16%', source: 'unverified' }])
    const blocked = await approve(post, tomorrow(), true)
    assert.equal(blocked.ok, false)
    if (!blocked.ok) assert.ok(blocked.issues?.some((d) => d.errors.some((e) => e.code === 'UNVERIFIED_FIGURE')))
    const copy = (await getDraft(post.id))!
    const saved = await saveDraft({ postId: post.id, baseRevisionId: copy.revision.id, edit: {
      title: copy.title, canonicalText: copy.revision.canonical_text,
      figures: copy.revision.figures.map((f) => ({ ...f, source: 'confirmed' })),
      destinations: copy.destinations.map((d) => ({ accountId: d.account_id, text: d.text, settings: d.settings })),
    } })
    assert.equal(saved.ok, true, JSON.stringify(saved))
    post = (await getPost(post.id))!
    assert.equal((await approve(post)).ok, false)
    assert.equal((await rows(db, 'select 1 from social_approvals')).length, 0)
    assert.equal((await approve(post, tomorrow(), true)).ok, true)
  })

  for (const dst of [false, true]) {
    it(`refuses the sixth post on one Bucharest day${dst ? ', including October DST' : ''} (PRD 14.4)`, async () => {
      const account = await createAccount(db, brand)
      const date = dst ? nextOctoberSunday() : tomorrow().date
      for (let i = 0; i < 5; i++) assert.equal((await approve(await draft([account]), { date, time: '09:00' })).ok, true)
      const sixth = await draft([account])
      const result = await approve(sixth, { date, time: '18:00' })
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.error, /Limita zilnica/)
      assert.equal((await getPost(sixth.id))!.revision.id, sixth.revision.id, 'cap refusal makes no revision')
      assert.equal((await rows(db, 'select 1 from social_approvals')).length, 5)
      if (dst) assert.equal(localToInstant({ date, time: '03:30' })!.toISOString(), `${date}T00:30:00.000Z`)
    })
  }

  it('goes from draft through approvePost and the fake worker to published URLs in detail and list', async () => {
    const account = await createAccount(db, brand)
    const post = await draft([account])
    // Approval tolerates up to 60 seconds of clock skew; use the current minute so the claim is due.
    assert.equal((await approve(post, toLocalInputs(new Date()))).ok, true)
    const api = new WorkerApi({ baseUrl: 'http://127.0.0.1:3000', token: TOKEN, workerId: 'approval-worker', fetch: routeFetch })
    const submitted = await runFakeWorkerOnce(api, { scenario: 'ok' })
    assert.ok(submitted.some((s) => s.action === 'submitted'), JSON.stringify(submitted))
    assert.ok(submitted.every((s) => s.status === 200))
    await db.query("update social_delivery_jobs set next_check_at = now() - interval '1 second'")
    const steps = await runFakeWorkerOnce(api, { scenario: 'ok' })
    assert.ok(steps.some((s) => s.action === 'poll -> published' && s.status === 200), JSON.stringify(steps))
    const published = (await getPost(post.id))!
    assert.equal(published.status, 'published')
    assert.match(published.destinations[0].job!.remote_url!, /^https:\/\/example.com\/fake\//)
    assert.equal((await listPosts('published'))[0].destinations[0].job!.remote_url, published.destinations[0].job!.remote_url)
  })

  it('cancels one destination; retry only failed jobs and requires RECONCILE_MISS confirmation', async () => {
    const accounts = await Promise.all(['x', 'facebook', 'linkedin-page'].map((p) => createAccount(db, brand, p)))
    let post = await draft(accounts)
    assert.equal((await approve(post)).ok, true)
    post = (await getPost(post.id))!
    assert.equal((await cancelDestination({ postId: post.id, jobId: post.destinations[0].job!.id })).ok, true)
    const failed = post.destinations[1].job!.id
    await db.query("update social_delivery_jobs set status = 'failed', last_error_code = 'RECONCILE_MISS' where id = $1", [failed])
    const result = await retryFailed({ postId: post.id })
    assert.equal(result.ok, true)
    if (result.ok) { assert.equal(result.retried, 0); assert.equal(result.skipped[0].reason, 'NEEDS_CONFIRMATION') }
    const retried = await retryFailed({ postId: post.id, confirmReconcileMiss: true })
    assert.equal(retried.ok, true)
    if (retried.ok) assert.equal(retried.retried, 1)
    assert.equal((await rows(db, "select 1 from social_delivery_jobs where status = 'cancelled'")).length, 1)
    assert.equal((await cancelPost({ postId: post.id })).ok, true)
    assert.equal((await getPost(post.id))!.status, 'cancelled')
    assert.equal((await retryFailed({ postId: post.id })).ok, false)
  })

  it('rechecks stored content before approving, regardless of saved validation', async () => {
    const account = await createAccount(db, brand)
    const post = await draft([account], 'Profit sigur cu taxes.support.')
    const result = await approve(post)
    assert.equal(result.ok, false)
    if (!result.ok) {
      const codes = result.issues?.flatMap((d) => d.errors.map((e) => e.code)) ?? []
      assert.ok(codes.includes('BANNED_PHRASE'))
      assert.ok(codes.includes('BARE_DOMAIN'))
    }
    assert.equal((await rows(db, 'select 1 from social_delivery_jobs')).length, 0)
  })

  it('leaves published destinations with their revision when reopening only the unsent ones', async () => {
    const accounts = await Promise.all(['x', 'facebook'].map((p) => createAccount(db, brand, p)))
    let post = await draft(accounts)
    assert.equal((await approve(post)).ok, true)
    post = (await getPost(post.id))!
    const sent = post.destinations[0].job!
    await db.query("update social_delivery_jobs set status = 'published', remote_url = 'https://example.test/published', published_at = now() where id = $1", [sent.id])
    const result = await reopenForEdit({ postId: post.id, revisionId: post.revision.id })
    assert.equal(result.ok, true, JSON.stringify(result))
    const opened = (await getPost(post.id))!
    assert.equal(opened.destinations.length, 1)
    assert.equal(opened.earlierJobs.length, 1)
    assert.equal(opened.earlierJobs[0].id, sent.id)
    assert.equal(opened.earlierJobs[0].remote_url, 'https://example.test/published')
    assert.equal((await listPosts('drafts'))[0].earlier[0].job!.remote_url, 'https://example.test/published')
  })

  it('rejects stale revisions, invalid calendar dates and unknown filters', async () => {
    const account = await createAccount(db, brand)
    const post = await draft([account])
    assert.equal((await approvePost({ postId: post.id, revisionId: fakeId, figuresChecked: true })).ok, false)
    assert.equal((await approve(post, { date: '2027-02-30', time: '09:00' })).ok, false)
    assert.equal((await rows(db, 'select 1 from social_approvals')).length, 0)
    assert.equal(isPostFilter('constructor'), false)
    assert.equal(isPostFilter('drafts'), true)
  })
})

it('no API route imports approval, save, cancel or retry actions (PRD 14.1)', async () => {
  async function scan(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await scan(path)
      else if (entry.name.endsWith('.ts')) {
        const source = await readFile(path, 'utf8')
        assert.doesNotMatch(source, /(?:from\s*|import\s*\()['"][^'"]*(?:\/approval-actions|social\/actions)['"]/, path)
      }
    }
  }
  await scan(join(process.cwd(), 'src/app/api'))
})
