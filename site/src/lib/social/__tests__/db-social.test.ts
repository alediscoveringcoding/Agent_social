/**
 * Migration 0001 against a real Postgres (PGlite, built from every migration in
 * site/supabase/migrations; see src/lib/testing/pglite-db.ts). This is the state
 * machine of PRD 10.2 and the approval rules of F5, exercised through the same
 * SQL functions the worker API and the admin actions call.
 *
 * Every function takes an explicit `p_now`, so time is driven by the test.
 *
 * Limit to know: PGlite is ONE connection, so two claims can never be truly
 * simultaneous here. "No double claim" is proven sequentially (a leased job is
 * invisible to a second worker) and by the row locks in the function; the
 * truly parallel version is `npm run social:fake-worker -- --race 8` against a
 * local Supabase (site/README.md, "Run it locally").
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PGlite } from '@electric-sql/pglite'
import { migratedDb } from '../../testing/pglite-db.ts'

let db: PGlite

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

async function q(sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(sql, params)).rows
}
async function one(sql: string, params: unknown[] = []): Promise<Row> {
  const rows = await q(sql, params)
  assert.equal(rows.length, 1, `expected one row from: ${sql}`)
  return rows[0]
}
async function fn<T = Row>(sql: string, params: unknown[] = []): Promise<T> {
  const row = await one(sql, params)
  return Object.values(row)[0] as T
}
async function rejects(sql: string, params: unknown[], code: string) {
  await assert.rejects(() => db.query(sql, params), (e: Error) => {
    assert.match(e.message, new RegExp(code))
    return true
  })
}

const HASH = (c: string) => c.repeat(64)

let brandId: string
let otherBrandId: string
let userId: string

async function setup() {
  db = await migratedDb()
  brandId = (await one(`select id from social_brands where slug = 'taxes-support'`)).id
  otherBrandId = (await one(`select id from social_brands where slug = 'comets-of-web3'`)).id
  userId = (await one(`insert into auth.users (email) values ('admin@example.test') returning id`)).id
}

async function reset() {
  // Children first; approvals and approved revisions are protected by triggers,
  // so the guards are switched off for the cleanup only.
  await db.exec(`
    set session_replication_role = replica;
    delete from social_events; delete from social_publish_attempts; delete from social_delivery_jobs;
    delete from social_approvals; delete from social_destination_media; delete from social_destinations;
    update social_posts set current_revision_id = null;
    delete from social_post_revisions; delete from social_posts; delete from social_media;
    delete from social_generation_requests; delete from social_accounts; delete from social_workers;
    set session_replication_role = origin;
  `)
}

let integrationSeq = 0
async function account(opts: { platform?: string; mode?: string; status?: string; cap?: number; brand?: string } = {}) {
  const mode = opts.mode ?? 'auto'
  integrationSeq += 1
  return (
    await one(
      `insert into social_accounts (brand_id, platform, mode, status, postiz_integration_id, display_name, daily_cap)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [
        opts.brand ?? brandId,
        opts.platform ?? 'x',
        mode,
        opts.status ?? (mode === 'manual' ? 'manual' : 'connected'),
        mode === 'auto' ? `int-${integrationSeq}` : null,
        `Account ${integrationSeq}`,
        opts.cap ?? 5,
      ]
    )
  ).id as string
}

interface Dest {
  account_id: string
  text?: string
  scheduled_at: string | null
  figures?: unknown[]
}

async function draft(dests: Dest[], extra: Row = {}): Promise<{ post: string; revision: string }> {
  const post = await fn<string>(`select social_create_post($1::jsonb, $2::jsonb, $3::jsonb, $4)`, [
    JSON.stringify({ brand_id: brandId, kind: 'social', title: 'T', created_by: userId, ...extra }),
    JSON.stringify({ canonical_text: 'canonical' }),
    JSON.stringify(dests.map((d) => ({ text: 'Salut', settings: {}, ...d }))),
    '2026-10-01T08:00:00Z',
  ])
  const revision = (await one(`select current_revision_id from social_posts where id = $1`, [post])).current_revision_id
  return { post, revision }
}

async function approve(
  post: string,
  revision: string,
  opts: { figuresChecked?: boolean; containsFigures?: boolean; now?: string } = {}
) {
  const dests = await q(`select id from social_destinations where revision_id = $1`, [revision])
  return fn<string>(`select social_approve_revision($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`, [
    post,
    revision,
    userId,
    'admin@example.test',
    HASH('f'),
    opts.figuresChecked ?? false,
    JSON.stringify(
      dests.map((d, i) => ({
        id: d.id,
        destination_hash: HASH(String(i % 10)),
        contains_figures: opts.containsFigures ?? false,
        validation: { ok: true },
      }))
    ),
    opts.now ?? '2026-10-01T08:00:00Z',
  ])
}

const claim = (worker: string, now: string, enabled = true, limit = 5) =>
  fn<{ jobs: Row[] }>(`select social_claim_deliveries($1, $2, $3, $4)`, [worker, limit, enabled, now])
const submitting = (job: string, worker: string, attempt: number, now: string, enabled = true) =>
  fn<Row>(`select social_job_submitting($1, $2, $3, $4, $5)`, [job, worker, attempt, enabled, now])
const submitted = (job: string, worker: string, attempt: number, now: string, postId = 'pz-1') =>
  fn<Row>(`select social_job_submitted($1, $2, $3, $4, $5, $6)`, [job, worker, attempt, postId, 'grp', now])
const result = (
  job: string,
  worker: string,
  attempt: number,
  outcome: string,
  now: string,
  extra: { url?: string; code?: string; retryAfter?: number } = {}
) =>
  fn<Row>(`select social_job_result($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
    job,
    worker,
    attempt,
    outcome,
    extra.url ?? null,
    extra.code ?? null,
    extra.code ? `error ${extra.code}` : null,
    extra.retryAfter ?? null,
    now,
  ])
const jobOf = async (post: string) =>
  one(
    `select j.* from social_delivery_jobs j join social_destinations d on d.id = j.destination_id
      join social_post_revisions r on r.id = d.revision_id where r.post_id = $1 order by j.run_at limit 1`,
    [post]
  )
const events = async () => (await q(`select type from social_events order by id`)).map((r) => r.type)

describe('migration 0001: social publishing', () => {
before(setup)
after(async () => {
  await db.close()
})
beforeEach(reset)

describe('schema and access', () => {
  it('seeds the three brands', async () => {
    const slugs = (await q(`select slug from social_brands order by slug`)).map((r) => r.slug)
    assert.deepEqual(slugs, ['comets-of-web3', 'taxes-support', 'the-crypto-support'])
  })

  it('gives the browser roles no right on any social table or function', async () => {
    const tables = await q(
      `select c.relname, r.rolname, has_table_privilege(r.rolname, c.oid, 'SELECT,INSERT,UPDATE,DELETE') as any
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
        where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'social\\_%'`
    )
    assert.ok(tables.length >= 28)
    assert.deepEqual(tables.filter((t) => t.any), [])
    const rls = await q(
      `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and relkind = 'r' and relname like 'social\\_%' and not relrowsecurity`
    )
    assert.deepEqual(rls, [])
    const policies = await q(`select policyname from pg_policies where tablename like 'social\\_%'`)
    assert.deepEqual(policies, [])
    const fns = await q(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'social\\_%'
          and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))`
    )
    assert.deepEqual(fns, [])
  })

  it('creates the private media bucket with the 8 MiB and image-only limits', async () => {
    const b = await one(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'social-media'`)
    assert.equal(b.public, false)
    assert.equal(Number(b.file_size_limit), 8388608)
    assert.deepEqual(b.allowed_mime_types, ['image/png', 'image/jpeg', 'image/webp'])
  })
})

describe('approval (F5): one transaction, cap, figures', () => {
  it('creates one job per destination: queued for auto, manual_pending for manual', async () => {
    const auto = await account()
    const manual = await account({ platform: 'substack', mode: 'manual' })
    const { post, revision } = await draft([
      { account_id: auto, scheduled_at: '2026-11-02T08:00:00Z' },
      { account_id: manual, scheduled_at: '2026-11-02T09:00:00Z' },
    ])
    await approve(post, revision)
    const jobs = await q(`select status, run_at from social_delivery_jobs order by run_at`)
    assert.deepEqual(jobs.map((j) => j.status), ['queued', 'manual_pending'])
    assert.equal((await one(`select status from social_posts where id = $1`, [post])).status, 'approved')
  })

  it('refuses a destination with figures unless "figures checked", and any unverified figure', async () => {
    const acc = await account()
    const a = await draft([{ account_id: acc, scheduled_at: '2026-11-02T08:00:00Z' }])
    await rejects(
      `select social_approve_revision($1,$2,$3,'a',$4::text,false,(select jsonb_agg(jsonb_build_object('id', id, 'destination_hash', $4::text, 'contains_figures', true)) from social_destinations where revision_id = $2),'2026-10-01T08:00:00Z')`,
      [a.post, a.revision, userId, HASH('1')],
      'SOCIAL_FIGURES_NOT_CHECKED'
    )
    assert.equal((await q(`select 1 from social_approvals`)).length, 0)
    await approve(a.post, a.revision, { containsFigures: true, figuresChecked: true })

    const b = await draft([
      { account_id: acc, scheduled_at: '2026-11-03T08:00:00Z', figures: [{ value: '600 lei', source: 'unverified' }] },
    ])
    await assert.rejects(() => approve(b.post, b.revision, { figuresChecked: true }), /SOCIAL_UNVERIFIED_FIGURE/)
  })

  it('refuses without a time on every destination', async () => {
    const acc = await account()
    const { post, revision } = await draft([{ account_id: acc, scheduled_at: null }])
    await assert.rejects(() => approve(post, revision), /SOCIAL_MISSING_TIME/)
  })

  it('blocks a sixth post on the same Bucharest day, across the October DST change, and writes nothing', async () => {
    const acc = await account()
    // 00:30 EEST ... 23:30 EET: one 25-hour local day.
    for (const at of ['2026-10-24T21:30:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z', '2026-10-25T10:00:00Z', '2026-10-25T21:30:00Z']) {
      const d = await draft([{ account_id: acc, scheduled_at: at }])
      await approve(d.post, d.revision)
    }
    const sixth = await draft([{ account_id: acc, scheduled_at: '2026-10-25T21:59:00Z' }])
    await assert.rejects(() => approve(sixth.post, sixth.revision), /SOCIAL_DAILY_CAP/)
    assert.equal((await q(`select 1 from social_approvals where revision_id = $1`, [sixth.revision])).length, 0)
    assert.equal((await q(`select 1 from social_delivery_jobs`)).length, 5)
    // 00:00 on the 26th is the next day.
    const next = await draft([{ account_id: acc, scheduled_at: '2026-10-25T22:00:00Z' }])
    await approve(next.post, next.revision)
  })

  it('counts the 23-hour March day, manual destinations and a lowered cap', async () => {
    const acc = await account({ cap: 2 })
    const one1 = await draft([{ account_id: acc, scheduled_at: '2027-03-27T22:00:00Z' }]) // 00:00 EET
    await approve(one1.post, one1.revision)
    const one2 = await draft([{ account_id: acc, scheduled_at: '2027-03-28T20:59:00Z' }]) // 23:59 EEST
    await approve(one2.post, one2.revision)
    const third = await draft([{ account_id: acc, scheduled_at: '2027-03-28T12:00:00Z' }])
    await assert.rejects(() => approve(third.post, third.revision), /SOCIAL_DAILY_CAP/)

    const manual = await account({ platform: 'substack', mode: 'manual', cap: 1 })
    const m1 = await draft([{ account_id: manual, scheduled_at: '2026-11-02T08:00:00Z' }])
    await approve(m1.post, m1.revision)
    const m2 = await draft([{ account_id: manual, scheduled_at: '2026-11-02T18:00:00Z' }])
    await assert.rejects(() => approve(m2.post, m2.revision), /SOCIAL_DAILY_CAP/)
  })

  it('refuses an account of another brand and a stale base revision', async () => {
    const foreign = await account({ brand: otherBrandId })
    await assert.rejects(
      () => draft([{ account_id: foreign, scheduled_at: '2026-11-02T08:00:00Z' }]),
      /SOCIAL_ACCOUNT_OTHER_BRAND/
    )
    const acc = await account()
    const { post, revision } = await draft([{ account_id: acc, scheduled_at: '2026-11-02T08:00:00Z' }])
    await fn(`select social_save_revision($1, $2, $3, $4::jsonb, $5::jsonb, 'edit', '2026-10-01T09:00:00Z')`, [
      post, revision, userId, '{}', JSON.stringify([{ account_id: acc, text: 'v2', scheduled_at: '2026-11-02T08:00:00Z' }]),
    ])
    await assert.rejects(() => approve(post, revision), /SOCIAL_STALE_REVISION/)
  })
})

describe('immutability (PRD 14, check 2)', () => {
  it('rejects any direct change to an approved destination, its media, revision or approval', async () => {
    const acc = await account()
    const { post, revision } = await draft([{ account_id: acc, scheduled_at: '2026-11-02T08:00:00Z' }])
    await approve(post, revision)
    const dest = (await one(`select id from social_destinations where revision_id = $1`, [revision])).id
    const media = (
      await one(
        `insert into social_media (source, storage_path, mime, width, height, bytes, sha256)
         values ('upload', 'uploads/x.png', 'image/png', 10, 10, 100, $1) returning id`,
        [HASH('e')]
      )
    ).id

    await rejects(`update social_destinations set text = 'altered' where id = $1`, [dest], 'SOCIAL_REVISION_FROZEN')
    await rejects(`update social_destinations set scheduled_at = now() where id = $1`, [dest], 'SOCIAL_REVISION_FROZEN')
    await rejects(`update social_destinations set destination_hash = $2 where id = $1`, [dest, HASH('0')], 'SOCIAL_REVISION_FROZEN')
    await rejects(`delete from social_destinations where id = $1`, [dest], 'SOCIAL_REVISION_FROZEN')
    await rejects(
      `insert into social_destination_media (destination_id, media_id, position) values ($1, $2, 0)`,
      [dest, media],
      'SOCIAL_REVISION_FROZEN'
    )
    await rejects(`update social_post_revisions set canonical_text = 'x' where id = $1`, [revision], 'SOCIAL_REVISION_FROZEN')
    await rejects(`delete from social_posts where id = $1`, [post], 'SOCIAL_REVISION_FROZEN')
    await rejects(`delete from social_approvals`, [], 'SOCIAL_APPROVAL_IMMUTABLE')
    await rejects(`update social_approvals set figures_checked = true`, [], 'SOCIAL_APPROVAL_IMMUTABLE')
    await rejects(`update social_media set sha256 = $2 where id = $1`, [media, HASH('d')], 'SOCIAL_MEDIA_IMMUTABLE')
  })

  it('keeps a draft destination content insert-only too (an edit is a new revision)', async () => {
    const acc = await account()
    const { revision } = await draft([{ account_id: acc, scheduled_at: '2026-11-02T08:00:00Z' }])
    await rejects(
      `update social_destinations set text = 'edited' where revision_id = $1`,
      [revision],
      'SOCIAL_DESTINATION_IMMUTABLE'
    )
    await q(`update social_destinations set validation = '{"ok":false}' where revision_id = $1`, [revision])
  })

  it('rejects a destination whose platform differs from its account', async () => {
    const acc = await account({ platform: 'x' })
    const { revision } = await draft([{ account_id: acc, scheduled_at: '2026-11-02T08:00:00Z' }])
    const acc2 = await account({ platform: 'facebook' })
    await rejects(
      `insert into social_destinations (revision_id, account_id, platform) values ($1, $2, 'x')`,
      [revision, acc2],
      'SOCIAL_PLATFORM_MISMATCH'
    )
  })
})

describe('claim (PRD 10.3)', () => {
  async function approvedJob(at = '2026-11-02T08:00:00Z', opts: Parameters<typeof account>[0] = {}) {
    const acc = await account(opts)
    const d = await draft([{ account_id: acc, scheduled_at: at }])
    await approve(d.post, d.revision)
    return { ...d, account: acc, job: (await jobOf(d.post)).id as string }
  }

  it('does not hand a leased job to a second worker, and leases for 10 minutes', async () => {
    const { job } = await approvedJob()
    assert.deepEqual((await claim('w1', '2026-11-02T07:59:00Z')).jobs, [], 'not before run_at')
    const first = await claim('w1', '2026-11-02T08:00:10Z')
    assert.deepEqual(first.jobs.map((j) => [j.job_id, j.kind, j.attempt_no]), [[job, 'publish', 1]])
    assert.equal(new Date(first.jobs[0].lease_expires_at).toISOString(), '2026-11-02T08:10:10.000Z')
    assert.deepEqual((await claim('w2', '2026-11-02T08:00:11Z')).jobs, [])
    assert.deepEqual((await claim('w1', '2026-11-02T08:00:12Z')).jobs, [])
    const attempts = await q(`select attempt_no, worker_id from social_publish_attempts where job_id = $1`, [job])
    assert.deepEqual(attempts, [{ attempt_no: 1, worker_id: 'w1' }])
  })

  it('returns nothing at all with the kill switch off', async () => {
    await approvedJob()
    assert.deepEqual((await claim('w1', '2026-11-02T08:00:10Z', false)).jobs, [])
    assert.equal((await one(`select status from social_delivery_jobs`)).status, 'queued')
  })

  it('skips paused, reconnect-required and revoked-approval jobs, and respects the limit', async () => {
    await approvedJob('2026-11-02T08:00:00Z', { status: 'reconnect_required' })
    const paused = await approvedJob('2026-11-02T08:00:00Z')
    await q(`update social_accounts set paused = true where id = $1`, [paused.account])
    const revoked = await approvedJob('2026-11-02T08:00:00Z')
    await q(`update social_approvals set revoked_at = now(), revoked_reason = 'test' where revision_id = $1`, [revoked.revision])
    assert.deepEqual((await claim('w1', '2026-11-02T08:00:10Z')).jobs, [])

    for (let i = 0; i < 3; i++) await approvedJob('2026-11-02T08:00:00Z')
    assert.equal((await claim('w1', '2026-11-02T08:00:10Z', true, 2)).jobs.length, 2)
    assert.equal((await claim('w2', '2026-11-02T08:00:10Z', true, 9)).jobs.length, 1)
  })

  it('claimed + expired lease goes back to the queue; it can be claimed again with attempt 2', async () => {
    const { job } = await approvedJob()
    await claim('w1', '2026-11-02T08:00:00Z')
    assert.deepEqual((await claim('w2', '2026-11-02T08:09:59Z')).jobs, [])
    const again = await claim('w2', '2026-11-02T08:10:01Z')
    assert.deepEqual(again.jobs.map((j) => [j.job_id, j.attempt_no]), [[job, 2]])
    assert.equal((await submitting(job, 'w1', 1, '2026-11-02T08:10:02Z')).code, 'LEASE_LOST')
  })

  it('submitting + expired lease goes to reconciling, never straight back to the queue', async () => {
    const { job } = await approvedJob()
    await claim('w1', '2026-11-02T08:00:00Z')
    assert.equal((await submitting(job, 'w1', 1, '2026-11-02T08:00:05Z')).ok, true)
    const c = await claim('w2', '2026-11-02T08:10:30Z')
    assert.deepEqual(c.jobs.map((j) => [j.kind, j.attempt_no]), [['reconcile', 1]])
    const j = await one(`select status, last_error_code from social_delivery_jobs where id = $1`, [job])
    assert.deepEqual(j, { status: 'reconciling', last_error_code: 'UNKNOWN_RESULT' })
  })

  it('fails a job past its 2-hour stale window as STALE (and never claims it)', async () => {
    const { job, post } = await approvedJob()
    assert.deepEqual((await claim('w1', '2026-11-02T10:00:00Z')).jobs, [])
    const j = await one(`select status, last_error_code from social_delivery_jobs where id = $1`, [job])
    assert.deepEqual(j, { status: 'failed', last_error_code: 'STALE' })
    assert.deepEqual(await events(), ['delivery_stale'])
    assert.equal((await one(`select status from social_posts where id = $1`, [post])).status, 'failed')
  })

  it('refuses /submitting once the stale window has closed, or after the kill switch', async () => {
    const a = await approvedJob()
    await claim('w1', '2026-11-02T09:59:00Z')
    const late = await submitting(a.job, 'w1', 1, '2026-11-02T10:00:01Z')
    assert.equal(late.http, 409)
    assert.equal((await one(`select last_error_code from social_delivery_jobs where id = $1`, [a.job])).last_error_code, 'STALE')

    const b = await approvedJob('2026-11-03T08:00:00Z')
    await claim('w1', '2026-11-03T08:00:00Z')
    assert.equal((await submitting(b.job, 'w1', 1, '2026-11-03T08:00:05Z', false)).http, 409)
    assert.equal((await one(`select status from social_delivery_jobs where id = $1`, [b.job])).status, 'queued')
  })

  it('re-checks the daily cap at claim time when the cap was lowered after approval', async () => {
    const acc = await account()
    const jobs: string[] = []
    for (const at of ['2026-11-02T08:00:00Z', '2026-11-02T08:01:00Z']) {
      const d = await draft([{ account_id: acc, scheduled_at: at }])
      await approve(d.post, d.revision)
      jobs.push((await jobOf(d.post)).id)
    }
    await q(`update social_accounts set daily_cap = 1 where id = $1`, [acc])
    const c = await claim('w1', '2026-11-02T08:02:00Z')
    assert.deepEqual(c.jobs.map((j) => j.job_id), [jobs[0]])
    assert.deepEqual((await claim('w2', '2026-11-02T08:03:00Z')).jobs, [])
  })
})

describe('worker reports (PRD 10.2 transitions)', () => {
  async function claimed(at = '2026-11-02T08:00:00Z', platform = 'x') {
    const acc = await account({ platform })
    const d = await draft([{ account_id: acc, scheduled_at: at }])
    await approve(d.post, d.revision)
    const c = await claim('w1', at)
    return { ...d, account: acc, job: c.jobs[0].job_id as string }
  }

  it('publish -> submitting -> submitted -> poll -> published, idempotent at each step', async () => {
    const { job, post } = await claimed()
    assert.equal((await submitting(job, 'w1', 1, '2026-11-02T08:00:01Z')).ok, true)
    assert.equal((await submitting(job, 'w1', 1, '2026-11-02T08:00:02Z')).idempotent, true)
    assert.equal((await submitted(job, 'w1', 1, '2026-11-02T08:00:03Z')).ok, true)
    assert.equal((await submitted(job, 'w1', 1, '2026-11-02T08:00:04Z')).idempotent, true)
    assert.equal((await one(`select status from social_posts where id = $1`, [post])).status, 'publishing')

    assert.deepEqual((await claim('w2', '2026-11-02T08:00:20Z')).jobs, [], 'poll paced')
    const poll = await claim('w2', '2026-11-02T08:00:40Z')
    assert.deepEqual(poll.jobs.map((j) => [j.kind, j.attempt_no]), [['poll', 1]])
    // Same worker may poll again after 60 s; another worker may not while leased.
    assert.deepEqual((await claim('w3', '2026-11-02T08:01:41Z')).jobs, [])
    assert.equal((await claim('w2', '2026-11-02T08:01:41Z')).jobs.length, 1)

    const r = await result(job, 'w2', 1, 'published', '2026-11-02T08:02:00Z', { url: 'https://x.com/i/1' })
    assert.deepEqual(r, { ok: true, status: 'published' })
    assert.equal((await result(job, 'w2', 1, 'published', '2026-11-02T08:02:05Z')).idempotent, true)
    const j = await one(`select status, remote_url, published_at from social_delivery_jobs where id = $1`, [job])
    assert.equal(j.remote_url, 'https://x.com/i/1')
    assert.equal((await one(`select status from social_posts where id = $1`, [post])).status, 'published')
  })

  it('409 for a worker that does not hold the lease', async () => {
    const { job } = await claimed()
    assert.equal((await submitting(job, 'w9', 1, '2026-11-02T08:00:01Z')).http, 409)
    assert.equal((await result(job, 'w9', 1, 'failed', '2026-11-02T08:00:01Z', { code: 'TRANSIENT' })).http, 409)
    const hb = await fn<Row>(`select social_job_heartbeat($1, 'w1', 1, '2026-11-02T08:05:00Z')`, [job])
    assert.equal(new Date(hb.lease_expires_at).toISOString(), '2026-11-02T08:15:00.000Z')
    assert.equal((await fn<Row>(`select social_job_heartbeat($1, 'w2', 1, '2026-11-02T08:05:00Z')`, [job])).http, 409)
  })

  it('retry backs off 1 / 5 min and fails after 3 attempts with delivery_failed', async () => {
    const { job } = await claimed()
    await result(job, 'w1', 1, 'retry', '2026-11-02T08:00:05Z', { code: 'TRANSIENT' })
    let j = await one(`select status, next_attempt_at from social_delivery_jobs where id = $1`, [job])
    assert.equal(j.status, 'queued')
    assert.equal(new Date(j.next_attempt_at).toISOString(), '2026-11-02T08:01:05.000Z')
    assert.deepEqual((await claim('w1', '2026-11-02T08:01:00Z')).jobs, [], 'waits for the backoff')
    assert.equal((await claim('w1', '2026-11-02T08:01:06Z')).jobs[0].attempt_no, 2)
    await result(job, 'w1', 2, 'retry', '2026-11-02T08:01:10Z', { code: 'RATE_LIMITED', retryAfter: 120 })
    j = await one(`select next_attempt_at from social_delivery_jobs where id = $1`, [job])
    assert.equal(new Date(j.next_attempt_at).toISOString(), '2026-11-02T08:03:10.000Z')
    assert.equal((await claim('w1', '2026-11-02T08:03:10Z')).jobs[0].attempt_no, 3)
    await result(job, 'w1', 3, 'retry', '2026-11-02T08:03:20Z', { code: 'TRANSIENT' })
    j = await one(`select status, last_error_code from social_delivery_jobs where id = $1`, [job])
    assert.deepEqual(j, { status: 'failed', last_error_code: 'TRANSIENT' })
    assert.deepEqual(await events(), ['delivery_failed'])
  })

  it('AUTH_EXPIRED fails without retry and marks the account reconnect_required', async () => {
    const { job, account: acc } = await claimed()
    await result(job, 'w1', 1, 'failed', '2026-11-02T08:00:05Z', { code: 'AUTH_EXPIRED' })
    assert.equal((await one(`select status from social_accounts where id = $1`, [acc])).status, 'reconnect_required')
    assert.deepEqual(await events(), ['account_reconnect_required', 'delivery_failed'])
  })

  it('reconcile: first not_found re-queues once, the second fails RECONCILE_MISS', async () => {
    const { job } = await claimed()
    await submitting(job, 'w1', 1, '2026-11-02T08:00:01Z')
    assert.equal((await result(job, 'w1', 1, 'reconciling', '2026-11-02T08:00:30Z', { code: 'UNKNOWN_RESULT' })).status, 'reconciling')
    const rc = await claim('w1', '2026-11-02T08:01:00Z')
    assert.equal(rc.jobs[0].kind, 'reconcile')
    // Too early to call it missing: the worker reports nothing, and once the
    // lease runs out a reconcile claim 15 minutes after the attempt settles it.
    assert.equal((await result(job, 'w1', 1, 'not_found', '2026-11-02T08:16:00Z')).code, 'LEASE_LOST')
    assert.equal((await claim('w2', '2026-11-02T08:16:00Z')).jobs[0].kind, 'reconcile')
    assert.equal((await result(job, 'w2', 1, 'not_found', '2026-11-02T08:16:05Z')).status, 'queued')

    const again = await claim('w2', '2026-11-02T08:16:06Z')
    assert.deepEqual(again.jobs.map((j) => [j.kind, j.attempt_no]), [['publish', 2]])
    await submitting(job, 'w2', 2, '2026-11-02T08:16:07Z')
    await result(job, 'w2', 2, 'reconciling', '2026-11-02T08:16:30Z')
    await claim('w2', '2026-11-02T08:32:00Z')
    assert.equal((await result(job, 'w2', 2, 'not_found', '2026-11-02T08:32:05Z')).status, 'failed')
    const j = await one(`select last_error_code from social_delivery_jobs where id = $1`, [job])
    assert.equal(j.last_error_code, 'RECONCILE_MISS')
  })

  it('reconcile that finds the post: /submitted then published, no second create', async () => {
    const { job } = await claimed()
    await submitting(job, 'w1', 1, '2026-11-02T08:00:01Z')
    await result(job, 'w1', 1, 'reconciling', '2026-11-02T08:00:30Z')
    await claim('w1', '2026-11-02T08:01:00Z')
    assert.equal((await submitted(job, 'w1', 1, '2026-11-02T08:02:00Z', 'pz-found')).ok, true)
    const poll = await claim('w1', '2026-11-02T08:03:00Z')
    assert.equal(poll.jobs[0].kind, 'poll')
    await result(job, 'w1', 1, 'published', '2026-11-02T08:03:10Z', { url: 'https://dev.to/x' })
    assert.equal((await q(`select 1 from social_publish_attempts where job_id = $1`, [job])).length, 1)
  })

  it('rejects an outcome that makes no sense for the state', async () => {
    const { job } = await claimed()
    const r = await result(job, 'w1', 1, 'published', '2026-11-02T08:00:05Z')
    assert.equal(r.code, 'INVALID_TRANSITION', 'cannot publish what was never submitted')
    assert.equal((await result(job, 'w1', 1, 'nonsense', '2026-11-02T08:00:05Z')).http, 422)
  })
})

describe('revisions, cancel, retry, manual handoff', () => {
  it('editing an approved post revokes the approval and cancels unsubmitted jobs in one go', async () => {
    const acc = await account()
    const { post, revision } = await draft([{ account_id: acc, scheduled_at: '2026-11-02T08:00:00Z' }])
    await approve(post, revision)
    const v2 = await fn<string>(
      `select social_save_revision($1, $2, $3, '{}'::jsonb, $4::jsonb, 'reschedule', '2026-10-02T08:00:00Z')`,
      [post, revision, userId, JSON.stringify([{ account_id: acc, text: 'Salut', scheduled_at: '2026-11-03T08:00:00Z' }])]
    )
    assert.notEqual(v2, revision)
    const appr = await one(`select revoked_at is not null as revoked, revoked_reason from social_approvals where revision_id = $1`, [revision])
    assert.deepEqual(appr, { revoked: true, revoked_reason: 'reschedule' })
    assert.equal((await one(`select status from social_delivery_jobs`)).status, 'cancelled')
    assert.equal((await one(`select status, current_revision_id from social_posts where id = $1`, [post])).status, 'draft')
    assert.equal((await one(`select number from social_post_revisions where id = $1`, [v2])).number, 2)
  })

  it('refuses to carry a destination that already left into a new revision', async () => {
    const acc = await account()
    const { post, revision } = await draft([{ account_id: acc, scheduled_at: '2026-11-02T08:00:00Z' }])
    await approve(post, revision)
    const job = (await claim('w1', '2026-11-02T08:00:00Z')).jobs[0].job_id
    await submitting(job, 'w1', 1, '2026-11-02T08:00:01Z')
    await assert.rejects(
      () =>
        fn(`select social_save_revision($1, $2, $3, '{}'::jsonb, $4::jsonb, 'edit', '2026-11-02T08:00:02Z')`, [
          post, revision, userId, JSON.stringify([{ account_id: acc, scheduled_at: '2026-11-03T08:00:00Z' }]),
        ]),
      /SOCIAL_DESTINATION_IN_FLIGHT/
    )
  })

  it('cancels one destination or the whole post; a submitted job cannot be cancelled', async () => {
    const a1 = await account()
    const a2 = await account({ platform: 'facebook' })
    const { post, revision } = await draft([
      { account_id: a1, scheduled_at: '2026-11-02T08:00:00Z' },
      { account_id: a2, scheduled_at: '2026-11-02T09:00:00Z' },
    ])
    await approve(post, revision)
    const first = (await claim('w1', '2026-11-02T08:00:00Z')).jobs[0].job_id
    await submitting(first, 'w1', 1, '2026-11-02T08:00:01Z')
    await assert.rejects(
      () => fn(`select social_cancel($1, $2, $3, '2026-11-02T08:00:02Z')`, [post, first, userId]),
      /SOCIAL_NOT_CANCELLABLE/
    )
    const r = await fn<Row>(`select social_cancel($1, null, $2, '2026-11-02T08:00:03Z')`, [post, userId])
    assert.equal(r.cancelled, 1)
    const p = await one(`select status, cancelled_at from social_posts where id = $1`, [post])
    assert.equal(p.cancelled_at, null, 'something already left, so the post itself stays')
    assert.equal(p.status, 'publishing')
  })

  it('cancelling a draft cancels the post', async () => {
    const acc = await account()
    const { post } = await draft([{ account_id: acc, scheduled_at: null }])
    await fn(`select social_cancel($1, null, $2, '2026-10-02T08:00:00Z')`, [post, userId])
    assert.equal((await one(`select status from social_posts where id = $1`, [post])).status, 'cancelled')
  })

  it('"retry failed only" re-queues failed jobs inside their window and skips the rest', async () => {
    const a1 = await account()
    const a2 = await account({ platform: 'facebook' })
    const { post, revision } = await draft([
      { account_id: a1, scheduled_at: '2026-11-02T08:00:00Z' },
      { account_id: a2, scheduled_at: '2026-11-02T08:00:00Z' },
    ])
    await approve(post, revision)
    const jobs = (await claim('w1', '2026-11-02T08:00:00Z')).jobs.map((j) => j.job_id)
    await result(jobs[0], 'w1', 1, 'failed', '2026-11-02T08:00:05Z', { code: 'VALIDATION_REJECTED' })
    await submitting(jobs[1], 'w1', 1, '2026-11-02T08:00:05Z')
    await submitted(jobs[1], 'w1', 1, '2026-11-02T08:00:06Z')
    await claim('w1', '2026-11-02T08:01:00Z')
    await result(jobs[1], 'w1', 1, 'published', '2026-11-02T08:01:10Z', { url: 'https://fb.com/1' })
    assert.equal((await one(`select status from social_posts where id = $1`, [post])).status, 'partial')

    const r = await fn<Row>(`select social_retry_failed($1, $2, false, '2026-11-02T08:30:00Z')`, [post, userId])
    assert.deepEqual(r, { retried: 1, skipped: [] })
    assert.equal((await one(`select status from social_delivery_jobs where id = $1`, [jobs[0]])).status, 'queued')
    assert.equal((await one(`select status from social_delivery_jobs where id = $1`, [jobs[1]])).status, 'published')

    // Past the window, retry refuses: that is a reschedule.
    await claim('w1', '2026-11-02T08:30:00Z')
    await result(jobs[0], 'w1', 2, 'failed', '2026-11-02T08:30:05Z', { code: 'VALIDATION_REJECTED' })
    const late = await fn<Row>(`select social_retry_failed($1, $2, false, '2026-11-02T10:30:00Z')`, [post, userId])
    assert.equal(late.retried, 0)
    assert.equal(late.skipped[0].reason, 'STALE_WINDOW')
  })

  it('manual handoff: manual_due at the slot (once), then "mark as published" with the URL', async () => {
    const manual = await account({ platform: 'producthunt', mode: 'manual' })
    const { post, revision } = await draft([{ account_id: manual, scheduled_at: '2026-11-02T08:00:00Z' }])
    await approve(post, revision)
    await fn(`select social_sweep('2026-11-02T07:59:00Z')`)
    assert.deepEqual(await events(), [])
    await fn(`select social_sweep('2026-11-02T08:00:00Z')`)
    await fn(`select social_sweep('2026-11-02T08:05:00Z')`)
    assert.deepEqual(await events(), ['manual_due'])
    assert.deepEqual((await claim('w1', '2026-11-02T08:06:00Z')).jobs, [], 'workers never see manual jobs')
    const job = (await jobOf(post)).id
    await assert.rejects(
      () => fn(`select social_mark_manual_done($1, $2, 'not a url', '2026-11-02T09:00:00Z')`, [job, userId]),
      /SOCIAL_URL_REQUIRED/
    )
    await fn(`select social_mark_manual_done($1, $2, 'https://www.producthunt.com/posts/x', '2026-11-02T09:00:00Z')`, [job, userId])
    const j = await one(`select status, remote_url from social_delivery_jobs where id = $1`, [job])
    assert.deepEqual(j, { status: 'manual_done', remote_url: 'https://www.producthunt.com/posts/x' })
    assert.equal((await one(`select status from social_posts where id = $1`, [post])).status, 'published')
  })
})

describe('generation requests and drafts', () => {
  async function request() {
    return (
      await one(`insert into social_generation_requests (brand_id, input, requested_by) values ($1, $2, $3) returning id`, [
        brandId,
        JSON.stringify({ source: { type: 'topic', topic: 'x' }, platforms: ['x'], count: 1 }),
        userId,
      ])
    ).id as string
  }

  it('claims, finishes with drafts_ready, and treats re-delivery as done', async () => {
    const id = await request()
    const c = await fn<Row>(`select social_claim_generation('w1', 1, '2026-11-02T08:00:00Z')`)
    assert.equal(c.requests[0].request_id, id)
    assert.equal(c.requests[0].brand, 'taxes-support')
    assert.deepEqual((await fn<Row>(`select social_claim_generation('w2', 1, '2026-11-02T08:00:01Z')`)).requests, [])
    assert.equal(await fn(`select social_generation_lease_state($1, 'w2', '2026-11-02T08:00:02Z')`, [id]), 'lost')
    assert.equal(await fn(`select social_generation_lease_state($1, 'w1', '2026-11-02T08:00:02Z')`, [id]), 'ok')
    assert.equal((await fn<Row>(`select social_generation_finish($1, 'w1', 2, 0, '2026-11-02T08:01:00Z')`, [id])).ok, true)
    assert.equal((await fn<Row>(`select social_generation_finish($1, 'w1', 0, 2, '2026-11-02T08:02:00Z')`, [id])).idempotent, true)
    assert.deepEqual(await events(), ['drafts_ready'])
  })

  it('never duplicates a draft delivered twice (generation_ref)', async () => {
    const id = await request()
    const acc = await account()
    const payload = [
      JSON.stringify({ brand_id: brandId, generation_request_id: id, generation_ref: `${id}:1` }),
      JSON.stringify({ canonical_text: 'x' }),
      JSON.stringify([{ account_id: acc, text: 'x', scheduled_at: null }]),
    ]
    const first = await fn(`select social_create_post($1::jsonb, $2::jsonb, $3::jsonb)`, payload)
    const second = await fn(`select social_create_post($1::jsonb, $2::jsonb, $3::jsonb)`, payload)
    assert.ok(first)
    assert.equal(second, null)
    assert.equal((await q(`select 1 from social_posts`)).length, 1)
    assert.equal((await q(`select 1 from social_post_revisions`)).length, 1)
  })

  it('an expired lease re-queues, three times at most, then fails with generation_failed', async () => {
    const id = await request()
    let t = Date.parse('2026-11-02T08:00:00Z')
    for (let i = 0; i < 3; i++) {
      const c = await fn<Row>(`select social_claim_generation('w1', 1, $1)`, [new Date(t).toISOString()])
      assert.equal(c.requests.length, 1)
      t += 11 * 60 * 1000
    }
    await fn(`select social_sweep($1)`, [new Date(t).toISOString()])
    const g = await one(`select status, attempts, error_code from social_generation_requests where id = $1`, [id])
    assert.deepEqual(g, { status: 'failed', attempts: 3, error_code: 'LEASE_EXPIRED' })
    assert.deepEqual(await events(), ['generation_failed'])
  })

  it('emits worker_silent once per silence', async () => {
    await q(`insert into social_workers (worker_id, last_seen_at) values ('w1', '2026-11-02T08:00:00Z')`)
    await fn(`select social_sweep('2026-11-02T08:09:00Z')`)
    assert.deepEqual(await events(), [])
    await fn(`select social_sweep('2026-11-02T08:11:00Z')`)
    await fn(`select social_sweep('2026-11-02T08:30:00Z')`)
    assert.deepEqual(await events(), ['worker_silent'])
  })
})
})
