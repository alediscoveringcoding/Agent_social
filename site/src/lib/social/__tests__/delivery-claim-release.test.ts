/**
 * deliveries/claim hands claimed jobs back (social_release_deliveries) when it cannot
 * build their payloads, so they do not sit out a 10 minute lease. A stub admin client
 * stands in for the database; the SQL function itself is tested with its migration.
 */

import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import * as claimRoute from '@/app/api/worker/social/v1/deliveries/claim/route'

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef'
const JOB_A = '11111111-1111-4111-8111-111111111111'
const JOB_B = '22222222-2222-4222-8222-222222222222'

interface Stub {
  releases: Array<{ fn: string; args: Record<string, unknown> }>
  admin: unknown
}

/** `jobsQuery` answers the first read buildDeliveryJobs makes (social_delivery_jobs). */
function stub(opts: {
  claimed: Array<{ job_id: string; kind: string; attempt_no: number; lease_expires_at: string }>
  jobsQuery: { data: unknown; error: { message: string } | null }
  releaseError?: boolean
}): Stub {
  const releases: Stub['releases'] = []
  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'in', 'eq', 'order']) c[m] = () => c
    c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return c
  }
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === 'social_claim_deliveries') return { data: { jobs: opts.claimed }, error: null }
      releases.push({ fn, args })
      if (opts.releaseError) throw new Error('release exploded')
      return { data: opts.claimed.length, error: null }
    },
    from: (table: string) => {
      if (table === 'social_workers') return { upsert: async () => ({ error: null }) }
      if (table === 'social_delivery_jobs') return chain(opts.jobsQuery)
      return chain({ data: [], error: null })
    },
    storage: { from: () => ({ createSignedUrls: async () => ({ data: [], error: null }) }) },
  }
  return { releases, admin }
}

async function claim() {
  const req = new Request('http://127.0.0.1:3000/api/worker/social/v1/deliveries/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'x-worker-id': 'w1' },
    body: JSON.stringify({ limit: 5 }),
  })
  const res = await (claimRoute.POST as (r: Request) => Promise<Response>)(req)
  return { status: res.status, json: (await res.json()) as Record<string, any> } // eslint-disable-line @typescript-eslint/no-explicit-any
}

const lease = new Date(Date.now() + 600_000).toISOString()

describe('deliveries/claim releases what it cannot hand over', () => {
  const saved = { token: process.env.WORKER_TOKEN, enabled: process.env.SOCIAL_PUBLISHING_ENABLED }
  const quiet = console.error
  beforeEach(() => {
    process.env.WORKER_TOKEN = TOKEN
    process.env.SOCIAL_PUBLISHING_ENABLED = 'true'
    console.error = () => {}
  })
  afterEach(() => {
    console.error = quiet
    setTestAdminClient(null)
    if (saved.token === undefined) delete process.env.WORKER_TOKEN
    else process.env.WORKER_TOKEN = saved.token
    if (saved.enabled === undefined) delete process.env.SOCIAL_PUBLISHING_ENABLED
    else process.env.SOCIAL_PUBLISHING_ENABLED = saved.enabled
  })

  it('releases the publish jobs when building the payloads throws, and still answers 500', async () => {
    const s = stub({
      claimed: [
        { job_id: JOB_A, kind: 'publish', attempt_no: 1, lease_expires_at: lease },
        { job_id: JOB_B, kind: 'poll', attempt_no: 1, lease_expires_at: lease },
      ],
      jobsQuery: { data: null, error: { message: 'db down' } },
    })
    setTestAdminClient(s.admin as never)
    const { status } = await claim()
    assert.equal(status, 500)
    assert.equal(s.releases.length, 1)
    assert.equal(s.releases[0]!.fn, 'social_release_deliveries')
    // A poll job is not 'claimed' in the database and must never go back to the queue.
    assert.deepEqual(s.releases[0]!.args, { p_worker_id: 'w1', p_job_ids: [JOB_A] })
  })

  it('releases a claimed publish job that has no payload (skipped)', async () => {
    const s = stub({
      claimed: [{ job_id: JOB_A, kind: 'publish', attempt_no: 1, lease_expires_at: lease }],
      jobsQuery: { data: [], error: null },
    })
    setTestAdminClient(s.admin as never)
    const { status, json } = await claim()
    assert.equal(status, 200)
    assert.deepEqual(json.jobs, [])
    assert.deepEqual(s.releases[0]!.args, { p_worker_id: 'w1', p_job_ids: [JOB_A] })
  })

  it('a failing release is logged, not fatal', async () => {
    const s = stub({
      claimed: [{ job_id: JOB_A, kind: 'publish', attempt_no: 1, lease_expires_at: lease }],
      jobsQuery: { data: [], error: null },
      releaseError: true,
    })
    setTestAdminClient(s.admin as never)
    const { status } = await claim()
    assert.equal(status, 200)
    assert.equal(s.releases.length, 1)
  })
})
