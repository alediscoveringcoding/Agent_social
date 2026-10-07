/**
 * Task A3: the fake generator and fake worker drive every state an admin can
 * see, through the real worker API (in process, on PGlite). If this passes,
 * the scripts in site/scripts/ do the same against `npm run dev`.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PGlite } from '@electric-sql/pglite'
import { migratedDb } from '../../testing/pglite-db.ts'
import { createFakeSupabase } from '../../testing/fake-supabase.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { routeFetch } from '../../testing/route-fetch.ts'
import { adminUser, approvedPost, brandId, createAccount, resetSocial, rows } from '../../testing/social-fixtures.ts'
import { WorkerApi } from '../fake/worker-api-client.ts'
import { runFakeGeneratorOnce } from '../fake/fake-generator.ts'
import { FAKE_INTEGRATIONS, claimRace, runFakeWorkerOnce, syncFakeAccounts } from '../fake/fake-worker.ts'
import { DRAFT_FIXTURES } from '../fake/fixtures.ts'
import { DraftSchema } from '../schemas.ts'

const TOKEN = 'fake-worker-test-token-0123456789abcdef'
let db: PGlite
let brand: string
let user: string
let api: WorkerApi

const jobStatus = async (id: string) => (await rows(db, `select status, last_error_code from social_delivery_jobs where id = $1`, [id]))[0]
const due = (id: string) => rows(db, `update social_delivery_jobs set next_check_at = now() - interval '1 second', next_attempt_at = null where id = $1`, [id])

describe('fake generator and fake worker (A3)', () => {
  before(async () => {
    db = await migratedDb()
    setTestAdminClient(createFakeSupabase(db))
    brand = await brandId(db)
    user = await adminUser(db)
    api = new WorkerApi({ baseUrl: 'http://127.0.0.1:3000', token: TOKEN, workerId: 'fake-1', fetch: routeFetch })
  })
  after(async () => {
    setTestAdminClient(null)
    await db.close()
  })
  beforeEach(async () => {
    process.env.WORKER_TOKEN = TOKEN
    process.env.SOCIAL_PUBLISHING_ENABLED = 'true'
    await resetSocial(db)
  })

  it('every fixture is a valid Draft for the contract', () => {
    for (const f of DRAFT_FIXTURES) {
      const { name: _n, ...draft } = f
      assert.ok(DraftSchema.safeParse({ ...draft, client_ref: 'x' }).success, f.name)
    }
  })

  it('sync registers the fake channels (paused, unassigned) and can flag a reconnect', async () => {
    const r = await syncFakeAccounts(api)
    assert.equal(r.status, 200)
    assert.equal((await rows(db, `select 1 from social_accounts where paused and brand_id is null`)).length, FAKE_INTEGRATIONS.length)
    await syncFakeAccounts(api, { refreshNeeded: ['fake-x'] })
    const [x] = await rows(db, `select status from social_accounts where postiz_integration_id = 'fake-x'`)
    assert.equal(x.status, 'reconnect_required')
  })

  it('the generator delivers drafts, including ones that fail the content rules', async () => {
    for (const p of ['x', 'instagram', 'linkedin-page', 'facebook']) await createAccount(db, brand, p)
    await rows(db, `insert into social_generation_requests (brand_id, input) values ($1, $2)`, [
      brand,
      JSON.stringify({ source: { type: 'topic', topic: 'Declaratia Unica' }, platforms: ['x', 'instagram', 'linkedin-page', 'facebook'], kinds: ['social'], count: 6, language: 'ro', templates: ['dark'] }),
    ])
    const [r] = await runFakeGeneratorOnce(api)
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { created: 6, skipped: 0 })
    const codes = (await rows(db, `select distinct jsonb_array_elements(validation->'errors')->>'code' as code from social_destinations`))
      .map((c) => c.code)
      .sort()
    for (const expected of ['BANNED_PHRASE', 'BARE_DOMAIN', 'DIACRITICS', 'IG_NO_IMAGE', 'IG_URL', 'TOO_LONG', 'UNVERIFIED_FIGURE']) {
      assert.ok(codes.includes(expected), `no draft shows ${expected} (got ${codes.join(', ')})`)
    }
    assert.deepEqual((await rows(db, `select type from social_events`)).map((e) => e.type), ['drafts_ready'])
  })

  it('the generator can report a failure', async () => {
    await rows(db, `insert into social_generation_requests (brand_id, input) values ($1, '{"platforms":["x"],"count":1}')`, [brand])
    const [r] = await runFakeGeneratorOnce(api, { fail: true })
    assert.equal(r.status, 200)
    assert.equal((await rows(db, `select status from social_generation_requests`))[0].status, 'failed')
  })

  it('ok: submitted, then the poll publishes it with a URL', async () => {
    const { job, post } = await approvedPost(db, brand, user, await createAccount(db, brand, 'x'))
    const steps = await runFakeWorkerOnce(api, { scenario: 'ok' })
    assert.deepEqual(steps.map((s) => [s.action, s.status]), [['submitting', 200], ['submitted', 200]])
    assert.equal((await jobStatus(job)).status, 'submitted')
    await due(job)
    await runFakeWorkerOnce(api)
    assert.equal((await jobStatus(job)).status, 'published')
    assert.match((await rows(db, `select remote_url from social_delivery_jobs where id = $1`, [job]))[0].remote_url, /^https:\/\/example\.com\/fake\/x\//)
    assert.equal((await rows(db, `select status from social_posts where id = $1`, [post]))[0].status, 'published')
  })

  it('fail, retry, auth and lose-lease each land in their state', async () => {
    const fail = await approvedPost(db, brand, user, await createAccount(db, brand, 'x'))
    await runFakeWorkerOnce(api, { scenario: 'fail' })
    assert.deepEqual(await jobStatus(fail.job), { status: 'failed', last_error_code: 'VALIDATION_REJECTED' })

    const retry = await approvedPost(db, brand, user, await createAccount(db, brand, 'facebook'))
    await runFakeWorkerOnce(api, { scenario: 'retry' })
    assert.deepEqual(await jobStatus(retry.job), { status: 'queued', last_error_code: 'TRANSIENT' })

    const authAcc = await createAccount(db, brand, 'linkedin-page')
    const auth = await approvedPost(db, brand, user, authAcc)
    await runFakeWorkerOnce(api, { scenario: 'auth' })
    assert.deepEqual(await jobStatus(auth.job), { status: 'failed', last_error_code: 'AUTH_EXPIRED' })
    assert.equal((await rows(db, `select status from social_accounts where id = $1`, [authAcc]))[0].status, 'reconnect_required')

    const lose = await approvedPost(db, brand, user, await createAccount(db, brand, 'instagram'))
    const steps = await runFakeWorkerOnce(api, { scenario: 'lose-lease' })
    assert.deepEqual(steps.find((s) => s.job_id === lose.job)?.status, 409)
    assert.equal((await jobStatus(lose.job)).status, 'claimed')
  })

  it('unknown result: reconciling, then reconcile finds it (no second create) or not', async () => {
    const found = await approvedPost(db, brand, user, await createAccount(db, brand, 'x'))
    await runFakeWorkerOnce(api, { scenario: 'unknown' })
    assert.deepEqual(await jobStatus(found.job), { status: 'reconciling', last_error_code: 'UNKNOWN_RESULT' })
    await runFakeWorkerOnce(api, { reconcile: 'found' })
    assert.equal((await jobStatus(found.job)).status, 'submitted')

    const missing = await approvedPost(db, brand, user, await createAccount(db, brand, 'facebook'))
    await runFakeWorkerOnce(api, { scenario: 'unknown' })
    await due(missing.job)
    await runFakeWorkerOnce(api, { reconcile: 'not_found', scenario: 'unknown' })
    assert.equal((await jobStatus(missing.job)).status, 'queued')
  })

  it('a worker never receives manual destinations, and claims do not overlap', async () => {
    await approvedPost(db, brand, user, await createAccount(db, brand, 'substack'))
    for (const p of ['x', 'facebook', 'linkedin-page']) await approvedPost(db, brand, user, await createAccount(db, brand, p))
    const race = await claimRace(api, 4)
    assert.equal(race.claimed, 3)
    assert.deepEqual(race.duplicates, [])
  })
})
