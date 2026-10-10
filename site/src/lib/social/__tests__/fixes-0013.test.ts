/**
 * Migration 0013 and the server code around it, on a temporary PGlite built
 * from the real migrations: POLL_TIMEOUT needs the same confirmation as
 * RECONCILE_MISS, a 'retry' result is refused for a submitted job, a research
 * draft cannot be approved without sources, a failed source copy cancels the
 * duplicate, a released claim gives its attempt back, and the events route
 * reports latest_id. Never calls an AI or publishing API.
 */

import { after, before, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { MIGRATIONS_DIR, migratedDb, migrationFiles } from '../../testing/pglite-db.ts'
import { createFakeSupabase, type FakeSupabase } from '../../testing/fake-supabase.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { setTestAdmin } from '../../testing/auth-shim.ts'
import { adminUser, approvedPost, brandId, createAccount, resetSocial, rows, scheduleAndApprove, type Row } from '../../testing/social-fixtures.ts'
import { approvePost, retryFailed } from '../approval-actions.ts'
import { getPost } from '../approval-queries.ts'
import { duplicatePost } from '../handoff-actions.ts'
import { toLocalInputs } from '../time.ts'
import * as eventsRoute from '@/app/api/automation/social/v1/events/route'

const N8N_TOKEN = 'fixes-0013-token-0123456789abcdef0123456'
const NIL = '00000000-0000-4000-8000-000000000000'
const MIN = 60_000
const HOUR = 60 * MIN

let db: PGlite
let fake: FakeSupabase
let brand: string
let admin: { userId: string; email: string }

const iso = (d: Date) => d.toISOString()
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms)
const tomorrow = () => toLocalInputs(new Date(Date.now() + 24 * 3600_000))

async function one(sql: string, params: unknown[] = []): Promise<Row> {
  const r = await rows(db, sql, params)
  assert.equal(r.length, 1, `expected one row from: ${sql}`)
  return r[0]
}
async function fn<T = Row>(sql: string, params: unknown[] = []): Promise<T> {
  return Object.values(await one(sql, params))[0] as T
}
const claim = (worker: string, now: Date, limit = 5) =>
  fn<{ jobs: Row[] }>(`select social_claim_deliveries($1, $2, true, $3)`, [worker, limit, iso(now)])
const submitting = (job: string, worker: string, attempt: number, now: Date, enabled = true) =>
  fn<Row>(`select social_job_submitting($1, $2, $3, $4, $5)`, [job, worker, attempt, enabled, iso(now)])
const submitted = (job: string, worker: string, attempt: number, now: Date) =>
  fn<Row>(`select social_job_submitted($1, $2, $3, 'pz-1', 'g-1', $4)`, [job, worker, attempt, iso(now)])
const result = (job: string, worker: string, attempt: number, outcome: string, now: Date, code: string | null = null) =>
  fn<Row>(`select social_job_result($1, $2, $3, $4, null, $5, $6, null, $7)`, [job, worker, attempt, outcome, code, code ? `error ${code}` : null, iso(now)])
const jobRow = (id: string) => one(`select * from social_delivery_jobs where id = $1`, [id])
const attemptRows = (id: string) => rows(db, `select attempt_no, outcome from social_publish_attempts where job_id = $1 order by attempt_no`, [id])

/** An approved one-destination post whose job is claimed, sent and submitted, then times out after 25 hours. */
async function pollTimedOut() {
  const account = await createAccount(db, brand, 'x')
  const { post, job } = await approvedPost(db, brand, admin.userId, account)
  const now = new Date()
  await claim('w1', now)
  await submitting(job, 'w1', 1, now)
  await submitted(job, 'w1', 1, now)
  const swept = await fn<Row>(`select social_sweep($1)`, [iso(plus(now, 25 * HOUR))])
  assert.equal(swept.poll_timeout, 1)
  const failed = await jobRow(job)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.last_error_code, 'POLL_TIMEOUT')
  assert.equal(failed.postiz_post_id, 'pz-1', 'the id of the post that may be live is still on the job')
  return { post, job, now }
}

/** A draft with one X destination; `request` links it to a generation request with that input. */
async function draft(text = 'Un ghid clar pentru documentele tale.', request?: Record<string, unknown>) {
  let generation_request_id: string | undefined
  if (request) {
    generation_request_id = (
      await one(`insert into social_generation_requests (brand_id, input, requested_by) values ($1, $2::jsonb, $3) returning id`, [
        brand,
        JSON.stringify({ platforms: ['x'], kinds: ['social'], count: 1, language: 'ro', templates: ['dark'], ...request }),
        admin.userId,
      ])
    ).id as string
  }
  const account = await createAccount(db, brand, 'x')
  const [{ id }] = await rows(db, 'select social_create_post($1::jsonb, $2::jsonb, $3::jsonb) as id', [
    JSON.stringify({ brand_id: brand, kind: 'social', title: 'Ghid', created_by: admin.userId, generation_request_id }),
    JSON.stringify({ canonical_text: text }),
    JSON.stringify([{ account_id: account, text, settings: {} }]),
  ])
  return id as string
}

const SRC = (n: number) => ({ url: `https://example.com/sursa-${n}`, title: `Sursa ${n}`, publisher: 'Example News', found_in_search: true })
const addSources = async (post: string, list: unknown[]): Promise<number> =>
  (await rows(db, 'select social_add_post_sources($1, $2::jsonb) as n', [post, JSON.stringify(list)]))[0].n

/** Approve the post's latest revision at tomorrow's time through the server action. */
async function approveLatest(postId: string) {
  const post = (await getPost(postId))!
  return approvePost({
    postId,
    revisionId: post.revision.id,
    times: Object.fromEntries(post.destinations.map((d) => [d.account_id, tomorrow()])),
    figuresChecked: false,
  })
}

describe('migration 0013 and the fixes around it', () => {
  before(async () => {
    db = await migratedDb()
    fake = createFakeSupabase(db)
    setTestAdminClient(fake)
    brand = await brandId(db)
    admin = { userId: await adminUser(db), email: 'admin@example.test' }
  })
  after(async () => {
    setTestAdminClient(null)
    setTestAdmin(null)
    await db.close()
  })
  beforeEach(async () => {
    setTestAdminClient(fake)
    await db.exec(`
      set session_replication_role = replica;
      delete from social_post_sources; delete from social_automation_runs;
      set session_replication_role = origin;`)
    await resetSocial(db)
    setTestAdmin(admin)
    process.env.N8N_AUTOMATION_TOKEN = N8N_TOKEN
    process.env.SOCIAL_PUBLISHING_ENABLED = 'true'
  })

  describe('retry after POLL_TIMEOUT', () => {
    it('is skipped without confirmation, and the job keeps the id of the post that may be live', async () => {
      const { post, job } = await pollTimedOut()
      const skipped = await fn<Row>(`select social_retry_failed($1, $2, false)`, [post, admin.userId])
      assert.deepEqual(skipped, { retried: 0, skipped: [{ job_id: job, reason: 'NEEDS_CONFIRMATION' }] })
      const after = await jobRow(job)
      assert.equal(after.status, 'failed')
      assert.equal(after.postiz_post_id, 'pz-1')
      assert.equal(after.retry_base, 0)
      // null counts as "not confirmed" as well.
      assert.equal((await fn<Row>(`select social_retry_failed($1, $2, null)`, [post, admin.userId])).retried, 0)
    })

    it('goes out again once a person confirmed it', async () => {
      const { post, job } = await pollTimedOut()
      const retried = await fn<Row>(`select social_retry_failed($1, $2, true)`, [post, admin.userId])
      assert.deepEqual(retried, { retried: 1, skipped: [] })
      const after = await jobRow(job)
      assert.equal(after.status, 'queued')
      assert.equal(after.postiz_post_id, null)
      assert.equal(after.retry_base, 1)
      assert.equal(after.reconcile_misses, 0)
    })

    it('RECONCILE_MISS still needs it, and other codes still do not', async () => {
      const { post, job } = await pollTimedOut()
      await rows(db, `update social_delivery_jobs set last_error_code = 'RECONCILE_MISS' where id = $1`, [job])
      assert.equal((await fn<Row>(`select social_retry_failed($1, $2, false)`, [post, admin.userId])).skipped[0].reason, 'NEEDS_CONFIRMATION')
      await rows(db, `update social_delivery_jobs set last_error_code = 'VALIDATION_REJECTED' where id = $1`, [job])
      assert.equal((await fn<Row>(`select social_retry_failed($1, $2, false)`, [post, admin.userId])).retried, 1)
    })

    it('the server action reports the skip in Romanian and retries with the confirmation', async () => {
      const { post, job } = await pollTimedOut()
      const first = await retryFailed({ postId: post })
      assert.equal(first.ok, true, JSON.stringify(first))
      if (!first.ok) return
      assert.equal(first.retried, 0)
      assert.deepEqual(first.skipped.map((s) => [s.job_id, s.reason]), [[job, 'NEEDS_CONFIRMATION']])
      assert.match(first.skipped[0].message, /confirma intai/)
      assert.equal((await jobRow(job)).status, 'failed')

      const second = await retryFailed({ postId: post, confirmReconcileMiss: true })
      assert.equal(second.ok && second.retried, 1, JSON.stringify(second))
      assert.equal((await jobRow(job)).status, 'queued')
      const [log] = await rows(db, `select details from social_activity_log where action = 'social.retry_failed' order by id desc limit 1`)
      assert.equal(log.details.confirm_reconcile_miss, true)
    })
  })

  describe("a 'retry' result for a submitted job", () => {
    it('is refused: the post already exists, so its id is not cleared', async () => {
      const account = await createAccount(db, brand, 'x')
      const { job } = await approvedPost(db, brand, admin.userId, account)
      const now = new Date()
      await claim('w1', now)
      await submitting(job, 'w1', 1, now)
      await submitted(job, 'w1', 1, now)
      // The poll lease is the only way a worker holds a submitted job.
      const poll = await claim('w2', plus(now, 40_000))
      assert.deepEqual(poll.jobs.map((j) => [j.kind, j.attempt_no]), [['poll', 1]])

      const refused = await result(job, 'w2', 1, 'retry', plus(now, 41_000), 'TRANSIENT')
      assert.equal(refused.ok, false)
      assert.equal(refused.http, 409)
      assert.equal(refused.code, 'INVALID_TRANSITION')
      const after = await jobRow(job)
      assert.equal(after.status, 'submitted')
      assert.equal(after.postiz_post_id, 'pz-1')
      assert.equal((await attemptRows(job))[0].outcome, 'submitted', 'the attempt is not marked as retried')

      // The worker still has the other honest outcomes.
      assert.equal((await result(job, 'w2', 1, 'published', plus(now, 42_000))).status, 'published')
    })

    it('is still accepted while claimed or submitting (before the post exists)', async () => {
      const account = await createAccount(db, brand, 'x')
      const { job } = await approvedPost(db, brand, admin.userId, account)
      const now = new Date()
      await claim('w1', now)
      assert.equal((await result(job, 'w1', 1, 'retry', plus(now, 1000), 'TRANSIENT')).status, 'queued', 'claimed')
      assert.equal((await claim('w1', plus(now, 2 * MIN))).jobs[0].attempt_no, 2)
      assert.equal((await submitting(job, 'w1', 2, plus(now, 2 * MIN))).ok, true)
      assert.equal((await result(job, 'w1', 2, 'retry', plus(now, 2 * MIN + 1000), 'TRANSIENT')).status, 'queued', 'submitting')
    })
  })

  describe('approval of a research draft', () => {
    it('is refused without sources, by the server action before any revision is written', async () => {
      const post = await draft(undefined, { source: { type: 'topic', topic: 'Declaratia Unica', hooks: [] }, research: true })
      const revisionsBefore = (await one(`select count(*)::int n from social_post_revisions where post_id = $1`, [post])).n

      const refused = await approveLatest(post)
      assert.equal(refused.ok, false)
      if (!refused.ok) assert.match(refused.error, /nu are surse/)
      assert.equal((await one(`select count(*)::int n from social_post_revisions where post_id = $1`, [post])).n, revisionsBefore, 'no time revision was saved')
      assert.equal((await one(`select count(*)::int n from social_approvals`)).n, 0)
    })

    it('is refused by the database itself (SOCIAL_SOURCES_MISSING), and works once sources are there and ticked', async () => {
      const post = await draft(undefined, { source: { type: 'topic', topic: 'Declaratia Unica', hooks: [] }, research: true })
      await assert.rejects(scheduleAndApprove(db, post, admin.userId), /SOCIAL_SOURCES_MISSING/)
      assert.equal((await one(`select count(*)::int n from social_approvals`)).n, 0)

      assert.equal(await addSources(post, [SRC(1)]), 1)
      await assert.rejects(scheduleAndApprove(db, post, admin.userId), /SOCIAL_SOURCES_NOT_VERIFIED/)
      await rows(db, `update social_post_sources set verified_at = now(), verified_by = $1 where post_id = $2`, [admin.userId, post])
      const approved = await scheduleAndApprove(db, post, admin.userId)
      assert.equal(approved.jobs.length, 1)
    })

    it('also applies to a news source without the research flag, and to the string "true"', async () => {
      const news = await draft(undefined, { source: { type: 'news', topic: '', window_days: 7 } })
      await assert.rejects(scheduleAndApprove(db, news, admin.userId), /SOCIAL_SOURCES_MISSING/)
      const refused = await approveLatest(news)
      assert.equal(refused.ok, false)
      if (!refused.ok) assert.match(refused.error, /nu are surse/)

      const stringy = await draft(undefined, { source: { type: 'topic', topic: 'x', hooks: [] }, research: 'true' })
      await assert.rejects(scheduleAndApprove(db, stringy, admin.userId), /SOCIAL_SOURCES_MISSING/)
    })

    it('goes through the server action once the sources are ticked', async () => {
      const post = await draft(undefined, { source: { type: 'topic', topic: 'Declaratia Unica', hooks: [] }, research: true })
      await addSources(post, [SRC(1), SRC(2)])
      const waiting = await approveLatest(post)
      assert.equal(waiting.ok, false)
      if (!waiting.ok) assert.match(waiting.error, /Verifica toate sursele/, 'sources exist but are unverified: the older message')
      await rows(db, `update social_post_sources set verified_at = now(), verified_by = $1 where post_id = $2`, [admin.userId, post])
      const done = await approveLatest(post)
      assert.equal(done.ok, true, JSON.stringify(done))
    })

    it('does not touch posts that did not ask for research, with or without a request', async () => {
      const manual = await draft()
      assert.equal((await approveLatest(manual)).ok, true)

      const plain = await draft(undefined, { source: { type: 'topic', topic: 'Declaratia Unica', hooks: [] } })
      assert.equal((await approveLatest(plain)).ok, true)

      const off = await draft(undefined, { source: { type: 'article', url: 'https://example.com/a', title: 'A' }, research: false })
      const approved = await scheduleAndApprove(db, off, admin.userId)
      assert.equal(approved.jobs.length, 1)
    })
  })

  describe('duplicatePost when the sources cannot be copied', () => {
    /** The same database, but the source copy fails the way a lost connection would (an error from the rpc). */
    function failSourceCopy() {
      setTestAdminClient({
        ...fake,
        rpc: (name: string, params: Record<string, unknown> = {}) =>
          fake.rpc(name, name === 'social_add_post_sources' ? { ...params, p_post: NIL } : params),
      })
    }

    it('cancels the new copy, reports it, and leaves the original and its sources alone', async () => {
      const post = await draft('Un ghid clar pentru documentele tale.', { source: { type: 'topic', topic: 'x', hooks: [] }, research: true })
      await addSources(post, [SRC(1), SRC(2)])
      const log = mock.method(console, 'error', () => {})
      try {
        failSourceCopy()
        const copied = await duplicatePost(post)
        assert.equal(copied.ok, false)
        if (!copied.ok) assert.match(copied.error, /copia a fost anulata/)
        assert.ok(log.mock.callCount() >= 1, 'the cause is logged on the server')
      } finally {
        log.mock.restore()
        setTestAdminClient(fake)
      }

      const posts = await rows(db, `select id, status, cancelled_at from social_posts order by created_at, id`)
      assert.equal(posts.length, 2)
      const copy = posts.find((p) => p.id !== post)!
      assert.equal(copy.status, 'cancelled')
      assert.ok(copy.cancelled_at)
      assert.equal((await one(`select count(*)::int n from social_post_sources where post_id = $1`, [copy.id])).n, 0)
      assert.equal((await one(`select count(*)::int n from social_post_sources where post_id = $1`, [post])).n, 2)
      assert.equal((await one(`select status from social_posts where id = $1`, [post])).status, 'draft')

      const [failed] = await rows(db, `select status, post_id, details, actor_email from social_activity_log where action = 'social.post_duplicate_failed'`)
      assert.equal(failed.status, 'error')
      assert.equal(failed.post_id, copy.id)
      assert.equal(failed.actor_email, admin.email)
      assert.deepEqual(failed.details, { source_post_id: post, reason: 'sources_not_copied', cancelled: true })
      assert.equal((await one(`select count(*)::int n from social_activity_log where action = 'social.post_duplicated'`)).n, 0, 'no success row')
    })

    it('a working database still copies the sources (same post, same call)', async () => {
      const post = await draft()
      await addSources(post, [SRC(1)])
      const copied = await duplicatePost(post)
      assert.equal(copied.ok, true, JSON.stringify(copied))
      if (copied.ok) {
        assert.equal((await one(`select count(*)::int n from social_post_sources where post_id = $1`, [copied.postId])).n, 1)
        assert.equal((await one(`select cancelled_at from social_posts where id = $1`, [copied.postId])).cancelled_at, null)
      }
    })
  })

  describe('a claim released at /submitting', () => {
    it('gives its attempt back and removes the unstarted attempt row (kill switch)', async () => {
      const account = await createAccount(db, brand, 'x')
      const { post, job } = await approvedPost(db, brand, admin.userId, account)
      const now = new Date()
      assert.equal((await claim('w1', now)).jobs[0].attempt_no, 1)
      assert.equal((await jobRow(job)).attempts, 1)

      const released = await submitting(job, 'w1', 1, now, false)
      assert.equal(released.ok, false)
      assert.equal(released.http, 409)
      const after = await jobRow(job)
      assert.deepEqual({ status: after.status, attempts: after.attempts, lease_owner: after.lease_owner, retry_base: after.retry_base }, { status: 'queued', attempts: 0, lease_owner: null, retry_base: 0 })
      assert.deepEqual(await attemptRows(job), [], 'no attempt row is left behind')
      assert.equal((await one(`select status from social_posts where id = $1`, [post])).status, 'approved')
      const [log] = await rows(db, `select details, job_id, post_id from social_activity_log where action = 'social.delivery_released'`)
      assert.deepEqual({ job: log.job_id, post: log.post_id, reason: log.details.reason, attempt_no: log.details.attempt_no }, { job, post, reason: 'submitting_gate', attempt_no: 1 })

      // The next claim reuses attempt 1.
      assert.equal((await claim('w2', plus(now, 1000))).jobs[0].attempt_no, 1)
    })

    it('does not use up the retry budget: three releases, then a transient error is still retried', async () => {
      const account = await createAccount(db, brand, 'x')
      const { job } = await approvedPost(db, brand, admin.userId, account)
      const now = new Date()
      for (let i = 0; i < 3; i++) {
        assert.equal((await claim('w1', plus(now, i * 1000))).jobs[0].attempt_no, 1)
        assert.equal((await submitting(job, 'w1', 1, plus(now, i * 1000 + 500), false)).ok, false)
      }
      assert.equal((await jobRow(job)).attempts, 0)
      assert.equal((await claim('w1', plus(now, 5000))).jobs[0].attempt_no, 1)
      assert.equal((await submitting(job, 'w1', 1, plus(now, 5500))).ok, true)
      const r = await result(job, 'w1', 1, 'retry', plus(now, 6000), 'TRANSIENT')
      assert.equal(r.status, 'queued', 'the first real attempt is retried, not failed')
    })

    it('does the same for a paused account and a revoked approval', async () => {
      const account = await createAccount(db, brand, 'x')
      const { job, revision } = await approvedPost(db, brand, admin.userId, account)
      const now = new Date()
      await claim('w1', now)
      await rows(db, `update social_accounts set paused = true where id = $1`, [account])
      assert.equal((await submitting(job, 'w1', 1, now)).ok, false)
      assert.equal((await jobRow(job)).attempts, 0)
      await rows(db, `update social_accounts set paused = false where id = $1`, [account])

      await claim('w1', plus(now, 1000))
      await rows(db, `update social_approvals set revoked_at = now(), revoked_reason = 'test' where revision_id = $1`, [revision])
      assert.equal((await submitting(job, 'w1', 1, plus(now, 1000))).ok, false)
      const after = await jobRow(job)
      assert.deepEqual({ status: after.status, attempts: after.attempts }, { status: 'queued', attempts: 0 })
      assert.deepEqual(await attemptRows(job), [])
    })

    it('keeps a sent attempt counted', async () => {
      const account = await createAccount(db, brand, 'x')
      const { job } = await approvedPost(db, brand, admin.userId, account)
      const now = new Date()
      await claim('w1', now)
      assert.equal((await submitting(job, 'w1', 1, now)).ok, true)
      assert.deepEqual((await attemptRows(job)).map((a) => a.attempt_no), [1])
      assert.equal((await jobRow(job)).attempts, 1)
      assert.ok((await one(`select submitting_at from social_publish_attempts where job_id = $1`, [job])).submitting_at)
    })

    it('leaves the STALE path as it was: the job fails and its attempt is finished, not removed', async () => {
      const account = await createAccount(db, brand, 'x')
      const { job } = await approvedPost(db, brand, admin.userId, account)
      const now = new Date()
      // Claimed inside the 2-hour window, submitted just after it closed (the lease is still valid).
      await claim('w1', plus(now, 119 * MIN))
      const stale = await submitting(job, 'w1', 1, plus(now, 121 * MIN))
      assert.equal(stale.http, 409)
      const failed = await jobRow(job)
      assert.deepEqual({ status: failed.status, code: failed.last_error_code, attempts: failed.attempts }, { status: 'failed', code: 'STALE', attempts: 1 })
      assert.deepEqual(await attemptRows(job), [{ attempt_no: 1, outcome: 'failed' }])
    })
  })

  describe('GET /events latest_id', () => {
    const get = async (query = '') => {
      const res = await eventsRoute.GET(new Request(`http://127.0.0.1:3000/api/automation/social/v1/events${query}`, { headers: { authorization: `Bearer ${N8N_TOKEN}` } }))
      return { status: res.status, json: (await res.json()) as Row }
    }

    it('is 0 on an empty outbox, and the highest id otherwise, whatever the page shows', async () => {
      const empty = await get()
      assert.deepEqual(empty.json, { events: [], next_after: 0, latest_id: 0 })

      for (let i = 1; i <= 5; i++) await rows(db, `select social_emit('drafts_ready', $1::jsonb)`, [JSON.stringify({ n: i })])
      const ids = (await rows(db, `select id from social_events order by id`)).map((e) => Number(e.id))
      const page = await get('?after=0&limit=2')
      assert.equal(page.status, 200)
      assert.deepEqual(page.json.events.map((e: Row) => e.id), ids.slice(0, 2))
      assert.equal(page.json.next_after, ids[1])
      assert.equal(page.json.latest_id, ids[4], 'the last page is not the last event')

      const caughtUp = await get(`?after=${ids[4]}`)
      assert.deepEqual(caughtUp.json, { events: [], next_after: ids[4], latest_id: ids[4] })
    })

    it('shows a database reset: the cursor is above latest_id', async () => {
      await rows(db, `select social_emit('drafts_ready', '{}'::jsonb)`)
      const [{ id }] = await rows(db, `select max(id) as id from social_events`)
      const stored = Number(id) + 500
      const r = await get(`?after=${stored}`)
      assert.deepEqual(r.json, { events: [], next_after: stored, latest_id: Number(id) })
      assert.ok(r.json.next_after > r.json.latest_id)
    })
  })

  describe('the migration itself', () => {
    it('applies over a database that holds data, applies again without harm, and keeps the grants', async () => {
      const stubs = readFileSync(join(import.meta.dirname, '..', '..', 'testing', 'supabase-stubs.sql'), 'utf8')
      const files = migrationFiles()
      const last = files.find((f) => f.startsWith('0013'))!
      assert.ok(last, '0013 exists')
      assert.equal(files.filter((f) => f.startsWith('0013')).length, 1)
      const old = await PGlite.create()
      try {
        await old.exec(stubs)
        for (const f of files.filter((name) => name < last)) await old.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
        await old.exec(`
          insert into social_posts (brand_id, kind, title, status)
            select id, 'social', 'Postare veche', 'draft' from social_brands where slug = 'taxes-support';`)
        await old.exec(readFileSync(join(MIGRATIONS_DIR, last), 'utf8'))
        await old.exec(readFileSync(join(MIGRATIONS_DIR, last), 'utf8'))

        assert.equal((await old.query(`select 1 from social_posts where title = 'Postare veche'`)).rows.length, 1, 'existing rows are untouched')
        for (const sig of [
          'public.social_retry_failed(uuid,uuid,boolean,timestamptz)',
          'public.social_job_result(uuid,text,integer,text,text,text,text,integer,timestamptz)',
          'public.social_approve_revision(uuid,uuid,uuid,text,text,boolean,jsonb,timestamptz)',
          'public.social_job_submitting(uuid,text,integer,boolean,timestamptz)',
        ]) {
          const [g] = (await old.query<Row>(
            `select has_function_privilege('service_role', $1::text, 'execute') as service,
                    has_function_privilege('anon', $1::text, 'execute') as anon,
                    has_function_privilege('authenticated', $1::text, 'execute') as auth`,
            [sig]
          )).rows
          assert.deepEqual(g, { service: true, anon: false, auth: false }, sig)
        }
        const same = (await old.query<Row>(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'social_retry_failed'`)).rows[0].n
        assert.equal(same, 1, 'replaced, not overloaded')
      } finally {
        await old.close()
      }
    })
  })
})
