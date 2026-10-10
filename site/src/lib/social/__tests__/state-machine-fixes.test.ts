/**
 * Migration 0011 (state machine fixes) against PGlite: approval checks,
 * single-destination cancel, POLL_TIMEOUT, retry budget, post status refresh,
 * release, generation re-delivery, integrity constraints, and the migration
 * applying on top of a database that already holds rows.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { MIGRATIONS_DIR, migratedDb, migrationFiles } from '../../testing/pglite-db.ts'
import {
  adminUser,
  approvedPost,
  brandId as brandIdOf,
  createAccount,
  resetSocial,
  rows,
  scheduleAndApprove,
  type Row,
} from '../../testing/social-fixtures.ts'

let db: PGlite
let brand: string
let other: string
let user: string

const iso = (d: Date) => d.toISOString()
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms)
const MIN = 60_000
const HOUR = 60 * MIN

async function one(sql: string, params: unknown[] = []): Promise<Row> {
  const r = await rows(db, sql, params)
  assert.equal(r.length, 1, `expected one row from: ${sql}`)
  return r[0]
}
async function fn<T = Row>(sql: string, params: unknown[] = []): Promise<T> {
  return Object.values(await one(sql, params))[0] as T
}
async function rejects(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (e: Error) => {
    assert.match(e.message, new RegExp(code))
    return true
  })
}
const claim = (worker: string, now: Date, limit = 5) =>
  fn<{ jobs: Row[] }>(`select social_claim_deliveries($1, $2, true, $3)`, [worker, limit, iso(now)])
const job = (id: string) => one(`select * from social_delivery_jobs where id = $1`, [id])
const postStatus = async (id: string) => (await one(`select status from social_posts where id = $1`, [id])).status as string
const events = async () => (await rows(db, `select type from social_events order by id`)).map((e) => e.type as string)

before(async () => {
  db = await migratedDb()
  brand = await brandIdOf(db)
  other = await brandIdOf(db, 'comets-of-web3')
  user = await adminUser(db)
})
beforeEach(async () => {
  await resetSocial(db)
})
after(async () => {
  await db.close()
})

describe('approval checks', () => {
  it('refuses an account of another brand', async () => {
    const account = await createAccount(db, brand, 'x')
    const [{ id: post }] = await rows(db, `select social_create_post($1::jsonb, $2::jsonb, $3::jsonb) as id`, [
      JSON.stringify({ brand_id: brand, kind: 'social', title: 't', created_by: user }),
      JSON.stringify({ canonical_text: 'salut' }),
      JSON.stringify([{ account_id: account, text: 'salut', settings: {}, scheduled_at: iso(plus(new Date(), HOUR)) }]),
    ])
    // save_revision refuses a foreign account itself; the approval repeats the
    // check for an account that changed brand after the draft was saved.
    const p = await one(`select current_revision_id as rev from social_posts where id = $1`, [post])
    const dest = await one(`select id from social_destinations where revision_id = $1`, [p.rev])
    await rows(db, `update social_accounts set brand_id = $1 where id = $2`, [other, account])
    await rejects(
      rows(db, `select social_approve_revision($1, $2, $3, 'a@example.test', repeat('b', 64), true, $4::jsonb)`, [
        post,
        p.rev,
        user,
        JSON.stringify([{ id: dest.id, destination_hash: 'a'.repeat(64) }]),
      ]),
      'SOCIAL_BRAND_MISMATCH'
    )
    assert.equal((await rows(db, `select 1 from social_approvals`)).length, 0)
  })

  it('refuses a slot already past the stale window, but not a manual one', async () => {
    const account = await createAccount(db, brand, 'x')
    const [{ id: post }] = await rows(db, `select social_create_post($1::jsonb, $2::jsonb, $3::jsonb) as id`, [
      JSON.stringify({ brand_id: brand, kind: 'social', title: 't', created_by: user }),
      JSON.stringify({ canonical_text: 'salut' }),
      JSON.stringify([{ account_id: account, text: 'salut', settings: {}, scheduled_at: null }]),
    ])
    await rejects(scheduleAndApprove(db, post, user, plus(new Date(), -3 * HOUR)), 'SOCIAL_SCHEDULE_STALE')

    const manual = await createAccount(db, brand, 'substack')
    const [{ id: post2 }] = await rows(db, `select social_create_post($1::jsonb, $2::jsonb, $3::jsonb) as id`, [
      JSON.stringify({ brand_id: brand, kind: 'social', title: 't2', created_by: user }),
      JSON.stringify({ canonical_text: 'salut' }),
      JSON.stringify([{ account_id: manual, text: 'salut', settings: {}, scheduled_at: null }]),
    ])
    const { jobs } = await scheduleAndApprove(db, post2, user, plus(new Date(), -3 * HOUR))
    assert.equal((await job(jobs[0])).status, 'manual_pending')
  })
})

describe('cancel', () => {
  it('cancelling the last live destination cancels the post, like the whole-post path', async () => {
    const account = await createAccount(db, brand, 'x')
    const { post, job: j } = await approvedPost(db, brand, user, account)
    await rows(db, `select social_cancel($1, $2, $3)`, [post, j, user])
    const p = await one(`select status, cancelled_at from social_posts where id = $1`, [post])
    assert.equal(p.status, 'cancelled')
    assert.ok(p.cancelled_at)
  })

  it('keeps the post open while another destination is live', async () => {
    const a = await createAccount(db, brand, 'x')
    const b = await createAccount(db, brand, 'bluesky')
    const [{ id: post }] = await rows(db, `select social_create_post($1::jsonb, $2::jsonb, $3::jsonb) as id`, [
      JSON.stringify({ brand_id: brand, kind: 'social', title: 't', created_by: user }),
      JSON.stringify({ canonical_text: 'salut' }),
      JSON.stringify([a, b].map((account_id) => ({ account_id, text: 'salut', settings: {}, scheduled_at: null }))),
    ])
    const { jobs } = await scheduleAndApprove(db, post, user)
    await rows(db, `select social_cancel($1, $2, $3)`, [post, jobs[0], user])
    assert.equal((await one(`select cancelled_at from social_posts where id = $1`, [post])).cancelled_at, null)
    assert.equal(await postStatus(post), 'approved')
  })
})

describe('sweep and post status', () => {
  it('claim marks the post publishing; an expired lease puts it back to approved', async () => {
    const account = await createAccount(db, brand, 'x')
    const { post, job: j } = await approvedPost(db, brand, user, account)
    const now = new Date()
    assert.equal((await claim('w1', now)).jobs.length, 1)
    assert.equal(await postStatus(post), 'publishing')
    await rows(db, `select social_sweep($1)`, [iso(plus(now, 11 * MIN))])
    assert.equal((await job(j)).status, 'queued')
    assert.equal(await postStatus(post), 'approved')
  })

  it('submitting refreshes the status as well', async () => {
    const account = await createAccount(db, brand, 'x')
    const { post, job: j } = await approvedPost(db, brand, user, account)
    const now = new Date()
    await claim('w1', now)
    // Paused account: the job goes back to the queue and the post follows.
    await rows(db, `update social_accounts set paused = true where id = $1`, [account])
    const r = await fn<Row>(`select social_job_submitting($1, 'w1', 1, true, $2)`, [j, iso(now)])
    assert.equal(r.ok, false)
    assert.equal(await postStatus(post), 'approved')
  })

  it('fails submitted and reconciling jobs after 24 hours as POLL_TIMEOUT', async () => {
    const account = await createAccount(db, brand, 'x')
    const { post, job: j } = await approvedPost(db, brand, user, account)
    const now = new Date()
    await claim('w1', now)
    await fn(`select social_job_submitting($1, 'w1', 1, true, $2)`, [j, iso(now)])
    await fn(`select social_job_submitted($1, 'w1', 1, 'pz-1', 'g-1', $2)`, [j, iso(now)])
    // Not yet.
    await rows(db, `select social_sweep($1)`, [iso(plus(now, 23 * HOUR))])
    assert.equal((await job(j)).status, 'submitted')
    const swept = await fn<Row>(`select social_sweep($1)`, [iso(plus(now, 25 * HOUR))])
    assert.equal(swept.poll_timeout, 1)
    const after = await job(j)
    assert.equal(after.status, 'failed')
    assert.equal(after.last_error_code, 'POLL_TIMEOUT')
    assert.equal(await postStatus(post), 'failed')
    assert.ok((await events()).includes('delivery_failed'))
    const log = await one(`select action, job_id, post_id from social_activity_log where action = 'social.poll_timeout'`)
    assert.equal(log.job_id, j)
    assert.equal(log.post_id, post)
    const attempt = await one(`select outcome, error_code, finished_at from social_publish_attempts where job_id = $1`, [j])
    assert.equal(attempt.error_code, 'POLL_TIMEOUT')
    assert.ok(attempt.finished_at)
  })
})

describe('retry budget', () => {
  it('a manual retry gets a fresh budget without reusing attempt numbers', async () => {
    const account = await createAccount(db, brand, 'x')
    const { post, job: j } = await approvedPost(db, brand, user, account)
    let t = new Date()
    for (let n = 1; n <= 3; n++) {
      assert.equal((await claim('w1', t)).jobs[0].attempt_no, n)
      const r = await fn<Row>(`select social_job_result($1, 'w1', $2, 'retry', null, 'TRANSIENT', 'x', null, $3)`, [j, n, iso(t)])
      assert.equal(r.status, n < 3 ? 'queued' : 'failed')
      t = plus(t, 20 * MIN)
    }
    const retried = await fn<Row>(`select social_retry_failed($1, $2, false, $3)`, [post, user, iso(plus(t, -19 * MIN))])
    assert.equal(retried.retried, 1)
    assert.equal((await job(j)).retry_base, 3)

    const c = await claim('w1', t)
    assert.equal(c.jobs[0].attempt_no, 4)
    const r = await fn<Row>(`select social_job_result($1, 'w1', 4, 'retry', null, 'TRANSIENT', 'x', null, $2)`, [j, iso(t)])
    assert.equal(r.status, 'queued', 'first attempt after a manual retry is retried, not failed at once')
    assert.deepEqual(
      (await rows(db, `select attempt_no from social_publish_attempts where job_id = $1 order by attempt_no`, [j])).map((a) => a.attempt_no),
      [1, 2, 3, 4]
    )
  })
})

describe('release', () => {
  it('gives back claimed jobs of that worker only, and the attempt number is reusable', async () => {
    const account = await createAccount(db, brand, 'x')
    const { post, job: j } = await approvedPost(db, brand, user, account)
    const now = new Date()
    await claim('w1', now)
    assert.equal(await fn(`select social_release_deliveries('w2', array[$1]::uuid[], $2)`, [j, iso(now)]), 0)
    assert.equal((await job(j)).status, 'claimed')
    assert.equal(await fn(`select social_release_deliveries('w1', array[$1]::uuid[], $2)`, [j, iso(now)]), 1)
    const after = await job(j)
    assert.equal(after.status, 'queued')
    assert.equal(after.attempts, 0)
    assert.equal(after.lease_owner, null)
    assert.equal(await postStatus(post), 'approved')
    assert.equal((await rows(db, `select 1 from social_activity_log where action = 'social.delivery_released'`)).length, 1)
    // Idempotent, and the job can be claimed again as attempt 1.
    assert.equal(await fn(`select social_release_deliveries('w1', array[$1]::uuid[], $2)`, [j, iso(now)]), 0)
    assert.equal((await claim('w2', plus(now, 1000))).jobs[0].attempt_no, 1)
  })

  it('does not touch a job that already moved on to submitting', async () => {
    const account = await createAccount(db, brand, 'x')
    const { job: j } = await approvedPost(db, brand, user, account)
    const now = new Date()
    await claim('w1', now)
    await fn(`select social_job_submitting($1, 'w1', 1, true, $2)`, [j, iso(now)])
    assert.equal(await fn(`select social_release_deliveries('w1', array[$1]::uuid[], $2)`, [j, iso(now)]), 0)
    assert.equal((await job(j)).status, 'submitting')
  })
})

describe('claim', () => {
  it('still takes at most the limit, oldest first, and moves past a capped account', async () => {
    const capped = await createAccount(db, brand, 'x')
    const free = await createAccount(db, brand, 'bluesky')
    const a = await approvedPost(db, brand, user, capped, 'unu')
    const b = await approvedPost(db, brand, user, capped, 'doi')
    const c = await approvedPost(db, brand, user, free, 'trei')
    await rows(db, `update social_accounts set daily_cap = 1 where id = $1`, [capped])
    const now = new Date()
    const got = await claim('w1', now, 2)
    const ids = got.jobs.map((x) => x.job_id)
    assert.equal(ids.length, 2)
    assert.ok(ids.includes(c.job), 'the free account is not starved by the capped one')
    assert.equal(ids.filter((x) => x === a.job || x === b.job).length, 1)
  })
})

describe('generation re-delivery', () => {
  async function request() {
    return (
      await one(`insert into social_generation_requests (brand_id, input, requested_by) values ($1, $2, $3) returning id`, [
        brand,
        JSON.stringify({ source: { type: 'topic', topic: 'x' }, platforms: ['x'], count: 1 }),
        user,
      ])
    ).id as string
  }

  it('same worker, same drafts again: nothing changes and nothing is emitted', async () => {
    const id = await request()
    await fn(`select social_claim_generation('w1', 1, '2026-11-02T08:00:00Z')`)
    assert.equal((await fn<Row>(`select social_generation_finish($1, 'w1', 2, 1, '2026-11-02T08:01:00Z')`, [id])).ok, true)
    // The re-posted body maps to the same generation_ref values: created 0, skipped 3.
    const again = await fn<Row>(`select social_generation_finish($1, 'w1', 0, 3, '2026-11-02T08:02:00Z')`, [id])
    assert.equal(again.idempotent, true)
    const g = await one(`select drafts_created, drafts_skipped from social_generation_requests where id = $1`, [id])
    assert.deepEqual({ ...g }, { drafts_created: 2, drafts_skipped: 1 })
    assert.deepEqual(await events(), ['drafts_ready'])
  })

  it('refuses a re-delivery from another worker', async () => {
    const id = await request()
    await fn(`select social_claim_generation('w1', 1, '2026-11-02T08:00:00Z')`)
    await fn(`select social_generation_finish($1, 'w1', 2, 0, '2026-11-02T08:01:00Z')`, [id])
    const r = await fn<Row>(`select social_generation_finish($1, 'w2', 2, 0, '2026-11-02T08:02:00Z')`, [id])
    assert.equal(r.ok, false)
    assert.equal(r.http, 409)
  })

  it('late new drafts add created and skipped and emit drafts_ready', async () => {
    const id = await request()
    await fn(`select social_claim_generation('w1', 1, '2026-11-02T08:00:00Z')`)
    await fn(`select social_generation_finish($1, 'w1', 1, 0, '2026-11-02T08:01:00Z')`, [id])
    await fn(`select social_generation_finish($1, 'w1', 2, 1, '2026-11-02T08:02:00Z')`, [id])
    const g = await one(`select drafts_created, drafts_skipped from social_generation_requests where id = $1`, [id])
    assert.deepEqual({ ...g }, { drafts_created: 3, drafts_skipped: 1 })
    assert.deepEqual(await events(), ['drafts_ready', 'drafts_ready'])
  })
})

describe('integrity', () => {
  it('a job cannot name an account other than its destination', async () => {
    const a = await createAccount(db, brand, 'x')
    const b = await createAccount(db, brand, 'bluesky')
    const { job: j } = await approvedPost(db, brand, user, a)
    await rejects(rows(db, `update social_delivery_jobs set account_id = $1 where id = $2`, [b, j]), 'SOCIAL_JOB_ACCOUNT_MISMATCH')
  })

  it('a post cannot point at the revision of another post', async () => {
    const a = await createAccount(db, brand, 'x')
    const p1 = await approvedPost(db, brand, user, a, 'unu')
    const p2 = await approvedPost(db, brand, user, await createAccount(db, brand, 'bluesky'), 'doi')
    await rejects(
      rows(db, `update social_posts set current_revision_id = $1 where id = $2`, [p2.revision, p1.post]),
      'SOCIAL_REVISION_NOT_OF_POST'
    )
  })

  it('one Postiz post id belongs to one job', async () => {
    const a = await approvedPost(db, brand, user, await createAccount(db, brand, 'x'), 'unu')
    const b = await approvedPost(db, brand, user, await createAccount(db, brand, 'bluesky'), 'doi')
    await rows(db, `update social_delivery_jobs set postiz_post_id = 'pz-1' where id = $1`, [a.job])
    await assert.rejects(
      rows(db, `update social_delivery_jobs set postiz_post_id = 'pz-1' where id = $1`, [b.job]),
      /social_jobs_postiz_post_unique/
    )
  })

  it('the same media cannot be attached twice to one destination', async () => {
    const a = await createAccount(db, brand, 'x')
    const [{ id: post }] = await rows(db, `select social_create_post($1::jsonb, $2::jsonb, $3::jsonb) as id`, [
      JSON.stringify({ brand_id: brand, kind: 'social', title: 't', created_by: user }),
      JSON.stringify({ canonical_text: 'salut' }),
      JSON.stringify([{ account_id: a, text: 'salut', settings: {}, scheduled_at: null }]),
    ])
    const media = (
      await one(
        `insert into social_media (source, storage_path, mime, width, height, bytes, sha256)
         values ('upload', 'uploads/dup.png', 'image/png', 10, 10, 100, repeat('e', 64)) returning id`
      )
    ).id
    const dest = (await one(`select d.id from social_destinations d join social_posts p on p.current_revision_id = d.revision_id where p.id = $1`, [post])).id
    await rows(db, `insert into social_destination_media (destination_id, media_id, position) values ($1, $2, 0)`, [dest, media])
    await assert.rejects(
      rows(db, `insert into social_destination_media (destination_id, media_id, position) values ($1, $2, 1)`, [dest, media]),
      /social_destination_media_unique_media/
    )
  })

  it('admin_update_account takes the manual-only list from one place', async () => {
    const def = await fn<string>(`select pg_get_functiondef('public.social_admin_update_account(uuid,jsonb,uuid,timestamptz)'::regprocedure)`)
    assert.match(def, /social_manual_only_platforms\(\)/)
    assert.doesNotMatch(def, /'producthunt'\)/)
  })
})

describe('migration 0011 on a database that already has data', () => {
  it('applies on top of 0001..0010 data, including rows that break the new constraints', async () => {
    const old = await PGlite.create()
    try {
      await old.exec(readFileSync(join(import.meta.dirname, '..', '..', 'testing', 'supabase-stubs.sql'), 'utf8'))
      for (const f of migrationFiles().filter((f) => f < '0011')) {
        await old.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
      }
      const b = await brandIdOf(old)
      const u = await adminUser(old)
      const x = await createAccount(old, b, 'x')
      const bs = await createAccount(old, b, 'bluesky')
      const p1 = await approvedPost(old, b, u, x, 'unu')
      const p2 = await approvedPost(old, b, u, bs, 'doi')
      // Violations the new constraints would refuse: a shared Postiz id and
      // the same media twice on one destination.
      await rows(old, `update social_delivery_jobs set postiz_post_id = 'dup'`)
      const media = (
        await rows(
          old,
          `insert into social_media (source, storage_path, mime, width, height, bytes, sha256)
           values ('upload', 'uploads/old.png', 'image/png', 10, 10, 100, repeat('a', 64)) returning id`
        )
      )[0].id
      const dest = (await rows(old, `select id from social_destinations limit 1`))[0].id
      await rows(old, `set session_replication_role = replica`)
      await rows(old, `insert into social_destination_media (destination_id, media_id, position) values ($1, $2, 0), ($1, $2, 1)`, [dest, media])
      await rows(old, `set session_replication_role = origin`)
      const before = {
        jobs: (await rows(old, `select id, status, attempts from social_delivery_jobs order by id`)),
        posts: (await rows(old, `select id, status, current_revision_id from social_posts order by id`)),
      }

      await old.exec(readFileSync(join(MIGRATIONS_DIR, '0011_state_machine_fixes.sql'), 'utf8'))
      // Idempotent: a second run is harmless.
      await old.exec(readFileSync(join(MIGRATIONS_DIR, '0011_state_machine_fixes.sql'), 'utf8'))

      assert.deepEqual(await rows(old, `select id, status, attempts from social_delivery_jobs order by id`), before.jobs)
      assert.deepEqual(await rows(old, `select id, status, current_revision_id from social_posts order by id`), before.posts)
      assert.equal(
        (await rows(old, `select 1 from pg_indexes where indexname in ('social_jobs_postiz_post_unique', 'social_destination_media_unique_media')`)).length,
        0,
        'constraints that existing rows violate are skipped'
      )
      assert.ok(p1.job && p2.job)
      assert.equal((await rows(old, `select retry_base from social_delivery_jobs`)).every((r) => r.retry_base === 0), true)
    } finally {
      await old.close()
    }
  })
})
