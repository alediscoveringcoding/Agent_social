import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PGlite } from '@electric-sql/pglite'
import { migratedDb } from '../../testing/pglite-db.ts'
import { createFakeSupabase } from '../../testing/fake-supabase.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { POST } from '@/app/api/worker/social/v1/generation/[id]/heartbeat/route'

let db: PGlite
const token = 'test-heartbeat-token-0123456789abcdef0123456789'
async function requestRow(status = 'running', expires = new Date(Date.now() + 20_000).toISOString()) {
  const { rows } = await db.query<{ id: string }>(`insert into social_generation_requests
    (brand_id, input, status, lease_owner, lease_expires_at) values
    ((select id from social_brands where slug = 'taxes-support'), '{}', $1, 'owner', $2) returning id`, [status, expires])
  return rows[0].id
}
async function call(id: string, worker = 'owner', bearer = token) {
  return POST(new Request(`http://127.0.0.1/api/worker/social/v1/generation/${id}/heartbeat`, {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'x-worker-id': worker }, body: '{}',
  }), { params: Promise.resolve({ id }) })
}

describe('generation heartbeat ownership and expiry', () => {
  before(async () => {
    process.env.WORKER_TOKEN = token
    db = await migratedDb()
    setTestAdminClient(createFakeSupabase(db))
  })
  after(async () => { setTestAdminClient(null); await db.close() })

  it('owner extends the lease and sweep one minute later keeps it running', async () => {
    const id = await requestRow()
    const response = await call(id)
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.ok(Date.parse(result.lease_expires_at) > Date.now() + 9 * 60_000)
    await db.query(`select social_sweep(now() + interval '1 minute')`)
    const { rows } = await db.query<{ status: string; lease_owner: string }>('select status, lease_owner from social_generation_requests where id=$1', [id])
    assert.deepEqual(rows[0], { status: 'running', lease_owner: 'owner' })
  })
  it('other owner, expired, finished, failed and queued requests return 409', async () => {
    assert.equal((await call(await requestRow(), 'other')).status, 409)
    assert.equal((await call(await requestRow('running', new Date(Date.now() - 1000).toISOString()))).status, 409)
    for (const status of ['done', 'failed', 'queued']) assert.equal((await call(await requestRow(status))).status, 409)
  })
  it('unknown request returns 404 and bad auth is refused', async () => {
    assert.equal((await call(crypto.randomUUID())).status, 404)
    assert.equal((await call('not-a-uuid')).status, 404)
    assert.equal((await call(await requestRow(), 'owner', 'wrong')).status, 401)
  })
  it('new function grants only service_role and refuses a null lease', async () => {
    const { rows } = await db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(`select
      has_function_privilege('anon', 'social_generation_heartbeat(uuid,text,timestamptz)', 'EXECUTE') as anon,
      has_function_privilege('authenticated', 'social_generation_heartbeat(uuid,text,timestamptz)', 'EXECUTE') as authenticated,
      has_function_privilege('service_role', 'social_generation_heartbeat(uuid,text,timestamptz)', 'EXECUTE') as service`)
    assert.deepEqual(rows[0], { anon: false, authenticated: false, service: true })
    const id = await requestRow()
    await db.query('update social_generation_requests set lease_expires_at = null where id=$1', [id])
    assert.equal((await call(id)).status, 409)
  })
})
