/**
 * The worker API (PRD 10.3) end to end inside the process: real route
 * handlers, real SQL functions on PGlite, a fake PostgREST in between
 * (src/lib/testing/fake-supabase.ts). Wall-clock time, so the fixtures are
 * scheduled relative to now.
 *
 * What these prove beyond db-social.test.ts: the HTTP contract (auth, status
 * codes, error bodies, body validation) and that a DeliveryJob carries
 * exactly what the worker needs to recompute destination_hash.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PGlite } from '@electric-sql/pglite'
import { migratedDb } from '../../testing/pglite-db.ts'
import { createFakeSupabase, type FakeSupabase } from '../../testing/fake-supabase.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { approvalHash, destinationHash } from '../hash.ts'
import * as claimRoute from '@/app/api/worker/social/v1/deliveries/claim/route'
import * as heartbeatRoute from '@/app/api/worker/social/v1/deliveries/[id]/heartbeat/route'
import * as submittingRoute from '@/app/api/worker/social/v1/deliveries/[id]/submitting/route'
import * as submittedRoute from '@/app/api/worker/social/v1/deliveries/[id]/submitted/route'
import * as resultRoute from '@/app/api/worker/social/v1/deliveries/[id]/result/route'
import * as genClaimRoute from '@/app/api/worker/social/v1/generation/claim/route'
import * as draftsRoute from '@/app/api/worker/social/v1/generation/[id]/drafts/route'
import * as genFailedRoute from '@/app/api/worker/social/v1/generation/[id]/failed/route'
import * as syncRoute from '@/app/api/worker/social/v1/accounts/sync/route'

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef'
const BASE = 'http://127.0.0.1:3000/api/worker/social/v1'

let db: PGlite
let fake: FakeSupabase
let brandId: string
let userId: string

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>

async function call(
  handler: Handler | ((req: Request) => Promise<Response>),
  path: string,
  body: unknown,
  opts: { id?: string; token?: string | null; worker?: string | null } = {}
): Promise<{ status: number; json: Json }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-worker-version': 'test/1' }
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`
  if (opts.worker !== null) headers['x-worker-id'] = opts.worker ?? 'w1'
  const req = new Request(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  const res = await (handler as Handler)(req, { params: Promise.resolve({ id: opts.id ?? '' }) })
  return { status: res.status, json: (await res.json()) as Json }
}

async function q(sql: string, params: unknown[] = []): Promise<Json[]> {
  return (await db.query<Json>(sql, params)).rows
}

let seq = 0
async function account(platform = 'x', extra: Json = {}): Promise<string> {
  seq += 1
  const [row] = await q(
    `insert into social_accounts (brand_id, platform, mode, status, postiz_integration_id, display_name, paused)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      extra.brand_id ?? brandId,
      platform,
      extra.mode ?? 'auto',
      extra.status ?? 'connected',
      extra.mode === 'manual' ? null : `int-${seq}`,
      `Cont ${seq}`,
      extra.paused ?? false,
    ]
  )
  return row.id
}

/** A post approved with REAL hashes, due a few seconds ago. */
async function approvedJob(opts: { platform?: string; withMedia?: boolean } = {}) {
  const acc = await account(opts.platform ?? 'x')
  const scheduled = new Date(Date.now() - 5_000)
  scheduled.setMilliseconds(0)
  let media: Json[] = []
  if (opts.withMedia) {
    const [m] = await q(
      `insert into social_media (source, storage_path, mime, width, height, bytes, sha256, alt_text)
       values ('generated', $1, 'image/png', 1600, 900, 1234, $2, 'Card') returning id, sha256`,
      [`generated/${crypto.randomUUID()}.png`, 'ab'.repeat(32)]
    )
    media = [{ media_id: m.id, position: 0, alt_text: 'Card cu termenul 25 mai' }]
  }
  const text = 'Ai pana pe 25 mai sa depui Declaratia Unica 📅'
  const settings = { who_can_reply: 'everyone' }
  const [{ id: post }] = await q(`select social_create_post($1::jsonb, $2::jsonb, $3::jsonb) as id`, [
    JSON.stringify({ brand_id: brandId, kind: 'social', title: 'T', created_by: userId }),
    JSON.stringify({ canonical_text: text }),
    JSON.stringify([{ account_id: acc, text, settings, scheduled_at: scheduled.toISOString(), media }]),
  ])
  const [{ current_revision_id: revision }] = await q(`select current_revision_id from social_posts where id = $1`, [post])
  const [dest] = await q(`select id from social_destinations where revision_id = $1`, [revision])
  const hash = destinationHash({
    account_id: acc,
    platform: opts.platform ?? 'x',
    text,
    settings,
    scheduled_at: scheduled,
    media: media.map((m) => ({ sha256: 'ab'.repeat(32), alt_text: m.alt_text })),
  })
  const aHash = approvalHash({ post_id: post, revision_id: revision, destinations: [{ id: dest.id, destination_hash: hash }] })
  await q(`select social_approve_revision($1, $2, $3, 'a@example.test', $4, true, $5::jsonb, now() - interval '1 minute')`, [
    post,
    revision,
    userId,
    aHash,
    JSON.stringify([{ id: dest.id, destination_hash: hash, contains_figures: true }]),
  ])
  const [job] = await q(`select id from social_delivery_jobs where destination_id = $1`, [dest.id])
  return { post, revision, account: acc, destination: dest.id, job: job.id as string, hash }
}

describe('worker API (PRD 10.3)', () => {
  before(async () => {
    db = await migratedDb()
    fake = createFakeSupabase(db)
    setTestAdminClient(fake)
    ;[{ id: brandId }] = await q(`select id from social_brands where slug = 'taxes-support'`)
    ;[{ id: userId }] = await q(`insert into auth.users (email) values ('a@example.test') returning id`)
  })
  after(async () => {
    setTestAdminClient(null)
    await db.close()
  })
  beforeEach(async () => {
    process.env.WORKER_TOKEN = TOKEN
    process.env.SOCIAL_PUBLISHING_ENABLED = 'true'
    await db.exec(`
      set session_replication_role = replica;
      delete from social_events; delete from social_publish_attempts; delete from social_delivery_jobs;
      delete from social_approvals; delete from social_destination_media; delete from social_destinations;
      update social_posts set current_revision_id = null;
      delete from social_post_revisions; delete from social_posts; delete from social_media;
      delete from social_generation_requests; delete from social_accounts; delete from social_workers;
      set session_replication_role = origin;`)
  })

  describe('authentication', () => {
    it('refuses a missing or wrong token with 401, in the contract error shape', async () => {
      const none = await call(claimRoute.POST, '/deliveries/claim', {}, { token: null })
      assert.equal(none.status, 401)
      assert.equal(none.json.error.code, 'UNAUTHORIZED')
      assert.equal((await call(claimRoute.POST, '/deliveries/claim', {}, { token: TOKEN + 'x' })).status, 401)
    })

    it('needs a well-formed X-Worker-Id', async () => {
      assert.equal((await call(claimRoute.POST, '/deliveries/claim', {}, { worker: null })).status, 400)
      assert.equal((await call(claimRoute.POST, '/deliveries/claim', {}, { worker: 'bad id with spaces' })).status, 400)
    })

    it('refuses everything while WORKER_TOKEN is unset or too short', async () => {
      process.env.WORKER_TOKEN = 'short'
      const r = await call(claimRoute.POST, '/deliveries/claim', {}, { token: 'short' })
      assert.equal(r.status, 503)
      delete process.env.WORKER_TOKEN
      assert.equal((await call(claimRoute.POST, '/deliveries/claim', {}, { token: '' })).status, 503)
    })

    it('records the worker on every authenticated call', async () => {
      await call(claimRoute.POST, '/deliveries/claim', {})
      const [w] = await q(`select worker_id, version, last_seen_at from social_workers`)
      assert.equal(w.worker_id, 'w1')
      assert.equal(w.version, 'test/1')
      assert.ok(Date.now() - new Date(w.last_seen_at).getTime() < 60_000)
    })
  })

  describe('deliveries', () => {
    it('claim returns nothing with the kill switch off', async () => {
      await approvedJob()
      process.env.SOCIAL_PUBLISHING_ENABLED = 'false'
      assert.deepEqual((await call(claimRoute.POST, '/deliveries/claim', { limit: 5 })).json, { jobs: [] })
      delete process.env.SOCIAL_PUBLISHING_ENABLED
      assert.deepEqual((await call(claimRoute.POST, '/deliveries/claim', { limit: 5 })).json, { jobs: [] })
    })

    it('claim returns a DeliveryJob from which the worker recomputes the approved hash', async () => {
      const j = await approvedJob({ withMedia: true })
      const r = await call(claimRoute.POST, '/deliveries/claim', { limit: 5 })
      assert.equal(r.status, 200)
      assert.equal(r.json.jobs.length, 1)
      const job = r.json.jobs[0]
      assert.deepEqual(Object.keys(job).sort(), [
        'account', 'attempt_no', 'attempt_started_at', 'destination', 'job_id', 'kind', 'lease_expires_at', 'media', 'postiz', 'run_at',
      ])
      assert.equal(job.job_id, j.job)
      assert.equal(job.kind, 'publish')
      assert.equal(job.attempt_no, 1)
      assert.match(job.lease_expires_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
      assert.match(job.destination.scheduled_at, /Z$/)
      assert.equal(job.postiz, null)
      assert.equal(job.media[0].mime, 'image/png')
      assert.match(job.media[0].url, /^http:\/\/storage\.test\/sign\/social-media\/generated\/.+ttl=3600$/)
      const recomputed = destinationHash({
        account_id: job.account.id,
        platform: job.account.platform,
        text: job.destination.text,
        settings: job.destination.settings,
        scheduled_at: job.destination.scheduled_at,
        media: job.media.map((m: Json) => ({ sha256: m.sha256, alt_text: m.alt_text })),
      })
      assert.equal(recomputed, job.destination.destination_hash)
      assert.equal(recomputed, j.hash)
      // A second worker gets nothing: the job is leased.
      assert.deepEqual((await call(claimRoute.POST, '/deliveries/claim', { limit: 5 }, { worker: 'w2' })).json.jobs, [])
    })

    it('walks publish -> submitting -> submitted -> poll -> published with the contract status codes', async () => {
      const j = await approvedJob()
      const [job] = (await call(claimRoute.POST, '/deliveries/claim', {})).json.jobs
      const id = job.job_id

      const hb = await call(heartbeatRoute.POST, `/deliveries/${id}/heartbeat`, { attempt_no: 1 }, { id })
      assert.equal(hb.status, 200)
      assert.match(hb.json.lease_expires_at, /Z$/)

      const lost = await call(submittingRoute.POST, `/deliveries/${id}/submitting`, { attempt_no: 1 }, { id, worker: 'w2' })
      assert.equal(lost.status, 409)
      assert.equal(lost.json.error.code, 'LEASE_LOST')

      assert.equal((await call(submittingRoute.POST, `/deliveries/${id}/submitting`, { attempt_no: 1 }, { id })).status, 200)
      const sub = { attempt_no: 1, postiz_post_id: 'pz-1', postiz_group: 'g-1' }
      assert.equal((await call(submittedRoute.POST, `/deliveries/${id}/submitted`, sub, { id })).status, 200)
      assert.equal((await call(submittedRoute.POST, `/deliveries/${id}/submitted`, sub, { id })).json.idempotent, true)

      // Poll paced at 30-60 s: force it due.
      await q(`update social_delivery_jobs set next_check_at = now() - interval '1 second' where id = $1`, [id])
      const poll = (await call(claimRoute.POST, '/deliveries/claim', {})).json.jobs[0]
      assert.equal(poll.kind, 'poll')
      assert.deepEqual(poll.postiz, { post_id: 'pz-1', group: 'g-1' })
      assert.match(poll.attempt_started_at, /Z$/)

      const done = await call(resultRoute.POST, `/deliveries/${id}/result`, {
        attempt_no: 1, outcome: 'published', remote_url: 'https://x.com/i/status/1',
      }, { id })
      assert.equal(done.status, 200)
      assert.equal(done.json.status, 'published')
      const [row] = await q(`select status, remote_url from social_delivery_jobs where id = $1`, [id])
      assert.deepEqual(row, { status: 'published', remote_url: 'https://x.com/i/status/1' })
      const [p] = await q(`select status from social_posts where id = $1`, [j.post])
      assert.equal(p.status, 'published')
    })

    it('validates bodies: 422 with the failing fields', async () => {
      const j = await approvedJob()
      await call(claimRoute.POST, '/deliveries/claim', {})
      const noCode = await call(resultRoute.POST, '/x', { attempt_no: 1, outcome: 'failed' }, { id: j.job })
      assert.equal(noCode.status, 422)
      assert.equal(noCode.json.error.details[0].path, 'error_code')
      const badUrl = await call(resultRoute.POST, '/x', { attempt_no: 1, outcome: 'published', remote_url: 'javascript:alert(1)' }, { id: j.job })
      assert.equal(badUrl.status, 422)
      assert.equal((await call(claimRoute.POST, '/deliveries/claim', { limit: 6 })).status, 422)
      assert.equal((await call(heartbeatRoute.POST, '/x', { attempt_no: 1 }, { id: 'not-a-uuid' })).status, 404)
      assert.equal((await call(heartbeatRoute.POST, '/x', { attempt_no: 1 }, { id: crypto.randomUUID() })).status, 404)
    })

    it('a failed result with AUTH_EXPIRED marks the account and writes the events', async () => {
      const j = await approvedJob()
      await call(claimRoute.POST, '/deliveries/claim', {})
      const r = await call(resultRoute.POST, '/x', {
        attempt_no: 1, outcome: 'failed', error_code: 'AUTH_EXPIRED', error_message: 'token expired',
      }, { id: j.job })
      assert.equal(r.status, 200)
      const [acc] = await q(`select status from social_accounts where id = $1`, [j.account])
      assert.equal(acc.status, 'reconnect_required')
      assert.deepEqual((await q(`select type from social_events order by id`)).map((e) => e.type), [
        'account_reconnect_required',
        'delivery_failed',
      ])
    })

    it('submitting is refused (409) once the kill switch is off, and the job goes back to the queue', async () => {
      const j = await approvedJob()
      await call(claimRoute.POST, '/deliveries/claim', {})
      process.env.SOCIAL_PUBLISHING_ENABLED = 'false'
      const r = await call(submittingRoute.POST, '/x', { attempt_no: 1 }, { id: j.job })
      assert.equal(r.status, 409)
      const [row] = await q(`select status from social_delivery_jobs where id = $1`, [j.job])
      assert.equal(row.status, 'queued')
    })
  })

  describe('generation', () => {
    async function request(platforms = ['x', 'instagram']) {
      const [r] = await q(`insert into social_generation_requests (brand_id, input, requested_by) values ($1, $2, $3) returning id`, [
        brandId,
        JSON.stringify({ source: { type: 'topic', topic: 'Declaratia Unica', hooks: ['deadline'] }, platforms, kinds: ['social'], count: 2, language: 'ro', templates: ['dark'] }),
        userId,
      ])
      return r.id as string
    }

    const draft = (ref: string) => ({
      client_ref: ref,
      kind: 'social',
      title: null,
      canonical_text: 'Ai pana pe 25 mai sa depui Declaratia Unica.',
      source_url: null,
      variants: [
        { platform: 'x', text: 'Ai pana pe 25 mai sa depui Declaratia Unica.', settings: {} },
        { platform: 'instagram', text: 'Termenul e 25 mai. Detalii in bio.', settings: { post_type: 'post' } },
      ],
      article: null,
      card: { template: 'dark', headline: 'Declaratia Unica pana pe 25 mai', keyword: '25 mai', stat: '25 mai', subline: 'Afla ce trebuie sa depui.', brand: 'taxes-support', alt_text: 'Card' },
      figures: [{ value: '25 mai', context: 'termen Declaratia Unica', source: 'facts' }],
      validation_errors: [],
      notes: null,
    })

    it('claim, deliver drafts (idempotent), drafts_ready', async () => {
      await account('x')
      await account('instagram')
      const id = await request()
      const c = await call(genClaimRoute.POST, '/generation/claim', { limit: 1 })
      assert.equal(c.status, 200)
      assert.deepEqual(Object.keys(c.json.requests[0]).sort(), ['brand', 'input', 'lease_expires_at', 'request_id'])
      assert.equal(c.json.requests[0].brand, 'taxes-support')

      const d = await call(draftsRoute.POST, `/generation/${id}/drafts`, { drafts: [draft('1'), draft('2')] }, { id })
      assert.deepEqual(d.json, { created: 2, skipped: 0 })
      const again = await call(draftsRoute.POST, `/generation/${id}/drafts`, { drafts: [draft('1'), draft('2')] }, { id })
      assert.deepEqual(again.json, { created: 0, skipped: 2 })
      assert.equal((await q(`select 1 from social_posts`)).length, 2)
      assert.equal((await q(`select 1 from social_destinations`)).length, 4)
      assert.deepEqual((await q(`select type from social_events`)).map((e) => e.type), ['drafts_ready'])
      const [g] = await q(`select status, drafts_created from social_generation_requests where id = $1`, [id])
      assert.deepEqual(g, { status: 'done', drafts_created: 2 })
    })

    it('refuses drafts from a worker without the lease (409) and unknown requests (404)', async () => {
      const id = await request()
      await call(genClaimRoute.POST, '/generation/claim', {})
      const other = await call(draftsRoute.POST, '/x', { drafts: [draft('1')] }, { id, worker: 'w2' })
      assert.equal(other.status, 409)
      const missing = crypto.randomUUID()
      assert.equal((await call(draftsRoute.POST, '/x', { drafts: [draft('1')] }, { id: missing })).status, 404)
    })

    it('failed marks the request and emits generation_failed', async () => {
      const id = await request()
      await call(genClaimRoute.POST, '/generation/claim', {})
      const r = await call(genFailedRoute.POST, '/x', { error_code: 'CLAUDE_REFUSED', error_message: 'refused' }, { id })
      assert.equal(r.status, 200)
      const [g] = await q(`select status, error_code from social_generation_requests where id = $1`, [id])
      assert.deepEqual(g, { status: 'failed', error_code: 'CLAUDE_REFUSED' })
      assert.deepEqual((await q(`select type from social_events`)).map((e) => e.type), ['generation_failed'])
    })
  })

  describe('accounts/sync', () => {
    const integration = (id: string, extra: Json = {}) => ({
      postiz_integration_id: id,
      provider: 'linkedin-page',
      name: 'Taxes Support',
      picture_url: 'https://media.example/p.png',
      profile_url: 'https://www.linkedin.com/company/example',
      disabled: false,
      refresh_needed: false,
      rules: { max_length: 3000 },
      ...extra,
    })

    it('adds new channels paused and unassigned, and records the sync time', async () => {
      await call(claimRoute.POST, '/deliveries/claim', {})
      const r = await call(syncRoute.POST, '/accounts/sync', {
        integrations: [integration('li-1'), integration('tt-1', { provider: 'vimeo' })],
        postiz_recent_posts: [],
      })
      assert.equal(r.status, 200)
      assert.equal(r.json.upserted, 1)
      assert.equal(r.json.ignored[0].postiz_integration_id, 'tt-1')
      const [a] = await q(`select platform, mode, status, paused, brand_id, rules from social_accounts`)
      assert.deepEqual(a, { platform: 'linkedin-page', mode: 'auto', status: 'connected', paused: true, brand_id: null, rules: { max_length: 3000 } })
      const [w] = await q(`select last_account_sync_at from social_workers where worker_id = 'w1'`)
      assert.ok(w.last_account_sync_at)
    })

    it('reconnect_required on refresh_needed, notified once, back to connected after', async () => {
      await call(syncRoute.POST, '/accounts/sync', { integrations: [integration('li-1')] })
      await call(syncRoute.POST, '/accounts/sync', { integrations: [integration('li-1', { refresh_needed: true })] })
      await call(syncRoute.POST, '/accounts/sync', { integrations: [integration('li-1', { refresh_needed: true })] })
      assert.equal((await q(`select status from social_accounts`))[0].status, 'reconnect_required')
      assert.deepEqual((await q(`select type from social_events`)).map((e) => e.type), ['account_reconnect_required'])
      await call(syncRoute.POST, '/accounts/sync', { integrations: [integration('li-1')] })
      assert.equal((await q(`select status from social_accounts`))[0].status, 'connected')
    })

    it('reports a Postiz post no job created as foreign_post, once', async () => {
      const j = await approvedJob()
      await q(`update social_delivery_jobs set postiz_post_id = 'ours' where id = $1`, [j.job])
      const body = {
        integrations: [],
        postiz_recent_posts: [
          { postiz_post_id: 'ours', integration_id: 'int-x', created_at: new Date().toISOString() },
          { postiz_post_id: 'theirs', integration_id: 'int-x', created_at: new Date().toISOString() },
        ],
      }
      assert.equal((await call(syncRoute.POST, '/accounts/sync', body)).json.foreign_posts, 1)
      assert.equal((await call(syncRoute.POST, '/accounts/sync', body)).json.foreign_posts, 0)
      const events = await q(`select type, payload->>'postiz_post_id' as post from social_events`)
      assert.deepEqual(events, [{ type: 'foreign_post', post: 'theirs' }])
    })
  })
})
