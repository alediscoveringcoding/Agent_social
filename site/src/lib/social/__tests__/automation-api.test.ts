/**
 * The automation API (PRD 10.4, amendment 07) end to end inside the process:
 * the real route handlers, the real SQL functions on PGlite, a fake PostgREST
 * in between. Same method as worker-api.test.ts.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'
import { migratedDb } from '../../testing/pglite-db.ts'
import { createFakeSupabase } from '../../testing/fake-supabase.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { resetSocial, rows } from '../../testing/social-fixtures.ts'
import { listAutomationRuns } from '../automation-queries.ts'
import * as requestsRoute from '@/app/api/automation/social/v1/generation-requests/route'
import * as eventsRoute from '@/app/api/automation/social/v1/events/route'
import * as runsRoute from '@/app/api/automation/social/v1/runs/route'

const TOKEN = 'n8n-test-token-0123456789abcdef0123456789'
const BASE = 'http://127.0.0.1:3000/api/automation/social/v1'
let db: PGlite

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

async function send(
  handler: (req: Request) => Promise<Response>,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  opts: { token?: string | null } = {}
): Promise<{ status: number; json: Json; headers: Headers }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`
  const init: RequestInit = { method, headers }
  if (method === 'POST') init.body = typeof body === 'string' ? body : JSON.stringify(body ?? {})
  const res = await handler(new Request(`${BASE}${path}`, init))
  return { status: res.status, json: (await res.json()) as Json, headers: res.headers }
}

const input = (extra: Json = {}) => ({
  source: { type: 'topic', topic: 'Declaratia Unica', hooks: ['termen'] },
  platforms: ['x', 'linkedin-page'],
  kinds: ['social'],
  count: 3,
  language: 'ro',
  templates: ['dark'],
  ...extra,
})
const createRequest = (body: Json, opts: { token?: string | null } = {}) => send(requestsRoute.POST, 'POST', '/generation-requests', body, opts)
const body = (extra: Json = {}) => ({ workflow: 'news-to-drafts', event_id: 'news-taxes-support-2026-10-12', brand: 'taxes-support', input: input(), ...extra })

describe('automation API (PRD 10.4)', () => {
  before(async () => {
    db = await migratedDb()
    setTestAdminClient(createFakeSupabase(db))
  })
  after(async () => {
    setTestAdminClient(null)
    await db.close()
  })
  beforeEach(async () => {
    process.env.N8N_AUTOMATION_TOKEN = TOKEN
    process.env.WORKER_TOKEN = 'worker-test-token-0123456789abcdef0123456'
    await db.exec(`set session_replication_role = replica; delete from social_automation_runs; set session_replication_role = origin;`)
    await resetSocial(db)
  })

  describe('authentication', () => {
    it('refuses a missing or wrong token with 401, in the worker API error shape, on every route', async () => {
      for (const [handler, method, path] of [
        [requestsRoute.POST, 'POST', '/generation-requests'],
        [eventsRoute.GET, 'GET', '/events'],
        [runsRoute.POST, 'POST', '/runs'],
      ] as const) {
        const none = await send(handler, method, path, body(), { token: null })
        assert.equal(none.status, 401, path)
        assert.equal(none.json.error.code, 'UNAUTHORIZED')
        assert.equal(typeof none.json.error.message, 'string')
        assert.equal(none.headers.get('cache-control'), 'no-store')
        assert.equal((await send(handler, method, path, body(), { token: TOKEN + 'x' })).status, 401, path)
        assert.equal((await send(handler, method, path, body(), { token: process.env.WORKER_TOKEN })).status, 401, 'the worker token does not open it')
      }
      assert.equal((await rows(db, `select count(*)::int n from social_generation_requests`))[0].n, 0)
    })

    it('answers 503 on every call while the token is unset or shorter than 32 characters', async () => {
      delete process.env.N8N_AUTOMATION_TOKEN
      const unset = await createRequest(body(), { token: TOKEN })
      assert.equal(unset.status, 503)
      assert.equal(unset.json.error.code, 'NOT_CONFIGURED')
      assert.equal((await send(eventsRoute.GET, 'GET', '/events', undefined, { token: '' })).status, 503)
      assert.equal((await send(runsRoute.POST, 'POST', '/runs', {}, { token: null })).status, 503, 'even without a header')

      process.env.N8N_AUTOMATION_TOKEN = 'short'
      assert.equal((await createRequest(body(), { token: 'short' })).status, 503)
      assert.equal((await rows(db, `select count(*)::int n from social_generation_requests`))[0].n, 0)
    })
  })

  describe('POST /generation-requests', () => {
    it('creates a request for the worker, with no requester and the idempotency key', async () => {
      const r = await createRequest(body())
      assert.equal(r.status, 200, JSON.stringify(r.json))
      assert.deepEqual(Object.keys(r.json).sort(), ['created', 'request_id'])
      assert.equal(r.json.created, true)

      const [row] = await rows(db, `select g.*, b.slug from social_generation_requests g join social_brands b on b.id = g.brand_id`)
      assert.equal(row.id, r.json.request_id)
      assert.equal(row.slug, 'taxes-support')
      assert.equal(row.requested_by, null)
      assert.equal(row.workflow, 'news-to-drafts')
      assert.equal(row.event_id, 'news-taxes-support-2026-10-12')
      assert.equal(row.status, 'queued')
      assert.equal(row.input.research, false, 'the schema default is applied')
      assert.equal(row.input.count, 3)

      const log = await rows(db, `select actor_id, actor_email, action, status, details from social_activity_log`)
      assert.equal(log.length, 1)
      assert.deepEqual(
        { actor_id: log[0].actor_id, actor_email: log[0].actor_email, action: log[0].action, status: log[0].status },
        { actor_id: null, actor_email: 'automation', action: 'social.generation_requested', status: 'success' }
      )
      assert.equal(log[0].details.request_id, r.json.request_id)
      assert.equal(log[0].details.workflow, 'news-to-drafts')
      assert.equal(log[0].details.source, 'topic')
    })

    it('is idempotent on workflow + event_id: the same event again changes and logs nothing', async () => {
      const first = await createRequest(body())
      const again = await createRequest(body())
      const different = await createRequest(body({ brand: 'comets-of-web3', input: input({ count: 9 }) }))
      assert.deepEqual(again.json, { request_id: first.json.request_id, created: false })
      assert.equal(different.json.request_id, first.json.request_id, 'the first call wins, whatever else is sent')
      assert.equal(different.json.created, false)

      assert.equal((await rows(db, `select count(*)::int n from social_generation_requests`))[0].n, 1)
      const [row] = await rows(db, `select input, brand_id from social_generation_requests`)
      assert.equal(row.input.count, 3)
      assert.equal((await rows(db, `select count(*)::int n from social_activity_log`))[0].n, 1)

      const other = await createRequest(body({ event_id: 'news-taxes-support-2026-10-14' }))
      assert.equal(other.json.created, true)
      assert.notEqual(other.json.request_id, first.json.request_id)
      const sameEventOtherWorkflow = await createRequest(body({ workflow: 'article-to-drafts' }))
      assert.equal(sameEventOtherWorkflow.json.created, true, 'the key is the pair')
      assert.equal((await rows(db, `select count(*)::int n from social_generation_requests`))[0].n, 3)
    })

    it('rejects an unknown brand with 422 BRAND_NOT_FOUND and creates nothing', async () => {
      const r = await createRequest(body({ brand: 'no-such-brand' }))
      assert.equal(r.status, 422)
      assert.equal(r.json.error.code, 'BRAND_NOT_FOUND')
      assert.equal((await rows(db, `select count(*)::int n from social_generation_requests`))[0].n, 0)
      assert.equal((await rows(db, `select count(*)::int n from social_activity_log`))[0].n, 0)
      assert.equal((await createRequest(body({ brand: 'Not A Slug' }))).status, 422)
    })

    it('rejects an input that fails GenerationInputSchema, and a malformed envelope', async () => {
      const bad: Array<[string, Json]> = [
        ['no platforms', body({ input: input({ platforms: [] }) })],
        ['unknown platform', body({ input: input({ platforms: ['myspace'] }) })],
        ['count 0', body({ input: input({ count: 0 }) })],
        ['count 21', body({ input: input({ count: 21 }) })],
        ['language en', body({ input: input({ language: 'en' }) })],
        ['article without url', body({ input: input({ source: { type: 'article' } }) })],
        ['article with a javascript url', body({ input: input({ source: { type: 'article', url: 'javascript:alert(1)' } }) })],
        ['topic too short', body({ input: input({ source: { type: 'topic', topic: 'ab', hooks: [] } }) })],
        ['news window 0', body({ input: input({ source: { type: 'news', topic: '', window_days: 0 } }) })],
        ['news window 31', body({ input: input({ source: { type: 'news', topic: '', window_days: 31 } }) })],
        ['unknown source type', body({ input: input({ source: { type: 'rss' } }) })],
        ['unknown ai model', body({ input: input({ ai: { provider: 'claude', model: 'gpt-9' } }) })],
        ['research not a boolean', body({ input: input({ research: 'yes' }) })],
        ['no input', { workflow: 'w', event_id: 'e', brand: 'taxes-support' }],
        ['uppercase workflow', body({ workflow: 'News_To_Drafts' })],
        ['workflow too long', body({ workflow: 'a'.repeat(65) })],
        ['empty event id', body({ event_id: '' })],
        ['event id too long', body({ event_id: 'e'.repeat(201) })],
      ]
      for (const [name, payload] of bad) {
        const r = await createRequest(payload)
        assert.equal(r.status, 422, name)
        assert.equal(r.json.error.code, 'INVALID_BODY', name)
        assert.ok(Array.isArray(r.json.error.details), name)
      }
      const notJson = await createRequest('{"workflow":' as unknown as Json)
      assert.equal(notJson.status, 400)
      assert.equal(notJson.json.error.code, 'INVALID_JSON')
      assert.equal((await rows(db, `select count(*)::int n from social_generation_requests`))[0].n, 0)
    })

    it('accepts a news source and research, and the worker claims it like any request', async () => {
      const news = { source: { type: 'news', topic: '' }, research: true, platforms: ['x'], count: 2 }
      const r = await createRequest(body({ event_id: 'news-taxes-support-2026-10-19', input: input(news) }))
      assert.equal(r.status, 200, JSON.stringify(r.json))
      const [row] = await rows(db, `select input from social_generation_requests where id = $1`, [r.json.request_id])
      assert.deepEqual(row.input.source, { type: 'news', topic: '', window_days: 7 })
      assert.equal(row.input.research, true)

      const claimed = await rows(db, `select social_claim_generation('automation-test-worker', 1) as r`)
      assert.equal(claimed[0].r.requests[0].request_id, r.json.request_id)
      assert.equal(claimed[0].r.requests[0].brand, 'taxes-support')
      assert.equal(claimed[0].r.requests[0].input.source.type, 'news')
    })

    it('is the only door it opens: no approve, schedule or publish', async () => {
      // Whatever n8n sends, the request just waits as 'queued'; nothing is approved.
      await createRequest(body({ input: input({ research: true }) }))
      assert.equal((await rows(db, `select count(*)::int n from social_approvals`))[0].n, 0)
      assert.equal((await rows(db, `select count(*)::int n from social_delivery_jobs`))[0].n, 0)
      assert.equal((await rows(db, `select count(*)::int n from social_posts`))[0].n, 0)
    })
  })

  describe('GET /events', () => {
    async function emit(n: number) {
      for (let i = 1; i <= n; i++) {
        await rows(db, `select social_emit($1, $2::jsonb)`, [i % 2 ? 'drafts_ready' : 'delivery_failed', JSON.stringify({ n: i })])
      }
    }

    it('pages by id with a cursor: oldest first, strictly after, next_after is the last id', async () => {
      await emit(5)
      const all = await rows(db, `select id from social_events order by id`)
      const ids = all.map((e) => Number(e.id))

      const p1 = await send(eventsRoute.GET, 'GET', '/events?after=0&limit=2')
      assert.equal(p1.status, 200)
      assert.deepEqual(p1.json.events.map((e: Json) => e.id), ids.slice(0, 2))
      assert.equal(p1.json.next_after, ids[1])
      assert.deepEqual(Object.keys(p1.json.events[0]).sort(), ['created_at', 'id', 'payload', 'type'])
      assert.equal(p1.json.events[0].type, 'drafts_ready')
      assert.deepEqual(p1.json.events[0].payload, { n: 1 })
      assert.match(p1.json.events[0].created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/)

      const p2 = await send(eventsRoute.GET, 'GET', `/events?after=${p1.json.next_after}&limit=2`)
      assert.deepEqual(p2.json.events.map((e: Json) => e.id), ids.slice(2, 4))
      const p3 = await send(eventsRoute.GET, 'GET', `/events?after=${p2.json.next_after}&limit=2`)
      assert.deepEqual(p3.json.events.map((e: Json) => e.id), ids.slice(4))
      assert.equal(p3.json.next_after, ids[4])

      const none = await send(eventsRoute.GET, 'GET', `/events?after=${p3.json.next_after}`)
      assert.deepEqual(none.json, { events: [], next_after: ids[4], latest_id: ids[4] }, 'nothing new: the cursor stays')
      const ahead = await send(eventsRoute.GET, 'GET', '/events?after=999999')
      assert.deepEqual(ahead.json, { events: [], next_after: 999999, latest_id: ids[4] }, 'a cursor above latest_id is a reset database')

      await emit(1)
      const fresh = await send(eventsRoute.GET, 'GET', `/events?after=${ids[4]}`)
      assert.equal(fresh.json.events.length, 1)
      assert.equal(fresh.json.next_after, fresh.json.events[0].id)
    })

    it('defaults to after=0 and limit=100, and does not mark anything as seen', async () => {
      await emit(3)
      const r = await send(eventsRoute.GET, 'GET', '/events')
      assert.equal(r.json.events.length, 3)
      assert.equal((await rows(db, `select count(*)::int n from social_events where seen_at is not null`))[0].n, 0)
      await rows(db, `insert into social_events (type, payload) select 'manual_due', '{}'::jsonb from generate_series(1, 120)`)
      assert.equal((await send(eventsRoute.GET, 'GET', '/events')).json.events.length, 100)
      assert.equal((await send(eventsRoute.GET, 'GET', '/events?limit=100')).json.events.length, 100)
    })

    it('rejects a cursor or limit out of range with 422', async () => {
      for (const q of ['after=-1', 'after=abc', 'after=1.5', 'limit=0', 'limit=101', 'limit=abc', 'limit=-3']) {
        const r = await send(eventsRoute.GET, 'GET', `/events?${q}`)
        assert.equal(r.status, 422, q)
        assert.equal(r.json.error.code, 'INVALID_QUERY', q)
      }
    })
  })

  describe('POST /runs', () => {
    const run = (extra: Json = {}) => send(runsRoute.POST, 'POST', '/runs', { workflow: 'events-to-email', event_id: 'poll-1', status: 'ok', ...extra })

    it('is an upsert on workflow + event_id: the second report replaces status and details', async () => {
      const first = await run({ details: { events: 3 } })
      assert.equal(first.status, 200)
      assert.deepEqual(first.json, { ok: true })
      const [a] = await rows(db, `select id, status, details, created_at::text c, updated_at::text u from social_automation_runs`)
      assert.equal(a.status, 'ok')
      assert.deepEqual(a.details, { events: 3 })

      const second = await run({ status: 'error', details: { error: 'smtp refused' } })
      assert.equal(second.status, 200)
      const all = await rows(db, `select id, status, details, created_at::text c, updated_at::text u from social_automation_runs`)
      assert.equal(all.length, 1)
      assert.equal(all[0].id, a.id)
      assert.equal(all[0].status, 'error')
      assert.deepEqual(all[0].details, { error: 'smtp refused' })
      assert.equal(all[0].c, a.c, 'the first report keeps its time')
      assert.ok(all[0].u > a.u, 'the last report moves updated_at')

      await run({ event_id: 'poll-2', status: 'skipped' })
      assert.equal((await rows(db, `select count(*)::int n from social_automation_runs`))[0].n, 2)
      await run({ workflow: 'news-to-drafts' })
      assert.equal((await rows(db, `select count(*)::int n from social_automation_runs`))[0].n, 3)
    })

    it('details are optional and default to an empty object', async () => {
      assert.equal((await run()).status, 200)
      assert.deepEqual((await rows(db, `select details from social_automation_runs`))[0].details, {})
    })

    it('logs activity as automation when a run is new or changes status, not for a repeat', async () => {
      await run()
      await run({ details: { again: true } })
      await run({ status: 'error' })
      await run({ status: 'error', details: { still: 'failing' } })
      const log = await rows(db, `select actor_id, actor_email, action, status, details from social_activity_log where action = 'social.automation_run' order by id`)
      assert.equal(log.length, 2)
      assert.deepEqual(log.map((l) => [l.actor_email, l.status, l.details.run_status]), [
        ['automation', 'success', 'ok'],
        ['automation', 'error', 'error'],
      ])
      assert.equal(log[1].details.previous, 'ok')
    })

    it('rejects a bad body with 422 and writes nothing', async () => {
      const bad: Array<[string, Json]> = [
        ['status', { status: 'done' }],
        ['no status', { status: undefined }],
        ['workflow', { workflow: 'Events To Email' }],
        ['empty event id', { event_id: '' }],
        ['details not an object', { details: 'text' }],
        ['details array', { details: [1, 2] }],
        ['details too large', { details: { blob: 'x'.repeat(10_001) } }],
      ]
      for (const [name, extra] of bad) {
        const r = await run(extra)
        assert.equal(r.status, 422, name)
        assert.equal(r.json.error.code, 'INVALID_BODY', name)
      }
      assert.equal((await send(runsRoute.POST, 'POST', '/runs', 'not json')).status, 400)
      assert.equal((await rows(db, `select count(*)::int n from social_automation_runs`))[0].n, 0)
    })

    it('listAutomationRuns reads them back, latest report first, limited', async () => {
      await run({ event_id: 'a' })
      await run({ event_id: 'b', status: 'skipped' })
      await run({ event_id: 'c', status: 'error', details: { why: 'x' } })
      await run({ event_id: 'a', status: 'error' })
      const list = await listAutomationRuns(10)
      assert.deepEqual(list.map((r) => r.event_id), ['a', 'c', 'b'])
      assert.deepEqual(list.map((r) => r.status), ['error', 'error', 'skipped'])
      assert.deepEqual(Object.keys(list[0]).sort(), ['created_at', 'details', 'event_id', 'id', 'status', 'updated_at', 'workflow'])
      assert.equal((await listAutomationRuns(2)).length, 2)
      assert.equal((await listAutomationRuns(0)).length, 1, 'limit is at least 1')
    })
  })

  describe('what the automation API can touch', () => {
    it('calls only the two automation functions and reads only social_events', () => {
      const dir = join(import.meta.dirname, '..', '..', '..', 'app', 'api', 'automation', 'social', 'v1')
      assert.deepEqual(readdirSync(dir).sort(), ['events', 'generation-requests', 'runs'])
      const files = [
        ...['events', 'generation-requests', 'runs'].map((d) => join(dir, d, 'route.ts')),
        join(import.meta.dirname, '..', 'server', 'automation-http.ts'),
      ]
      const rpcs = new Set<string>()
      const tables = new Set<string>()
      for (const file of files) {
        const text = readFileSync(file, 'utf8')
        for (const m of text.matchAll(/\.rpc\(\s*'([a-z_]+)'/g)) rpcs.add(m[1])
        for (const m of text.matchAll(/\.from\(\s*'([a-z_]+)'/g)) tables.add(m[1])
      }
      assert.deepEqual([...rpcs].sort(), ['social_automation_create_request', 'social_automation_log_run'])
      assert.deepEqual([...tables], ['social_events'])
    })
  })
})
