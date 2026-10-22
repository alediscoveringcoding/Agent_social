import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { migratedDb } from '../../testing/pglite-db.ts'
import { createFakeSupabase } from '../../testing/fake-supabase.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { setTestAdmin } from '../../testing/auth-shim.ts'
import { adminUser, approvedPost, brandId, rows } from '../../testing/social-fixtures.ts'
import { connectNativeCandidate, storeNativeCandidates } from '../candidates.ts'
import { connectNativeAccount, disconnectNativeAccount } from '../connection-actions.ts'
import { startNativeOAuth } from '../oauth-actions.ts'
import { selectNativeDestination } from '../candidate-actions.ts'
import { getTikTokCreator } from '../creator-actions.ts'
import { resolveNativePublication } from '../resolution-actions.ts'
import { nativeRecordKey } from '../server.ts'
import { POST } from '@/app/api/worker/social/v1/deliveries/[id]/native/route'
import { GET as callback } from '@/app/api/native/callback/route'
import type { NativeAccount } from '../types.ts'

let db: PGlite
let admin: SupabaseClient
let actor: string
let brand: string
const envelope = 'v1.encrypted-fixture-not-a-real-token-'.repeat(3)
async function connect(platform = 'bluesky', remote = randomUUID()): Promise<string> {
  return (await rows(db, `select social_native_connect($1,$2,'','Example',null,null,$3,$4,'{}',null,$5) as id`, [platform, remote, brand, envelope, actor]))[0].id
}

describe('native lifecycle security and durable transitions', () => {
  before(async () => {
    process.env.DB_MODE = 'local'; process.env.LOCAL_AUTH_SECRET = 'native-lifecycle-test-only-secret-0123456789'
    process.env.WORKER_TOKEN = 'native-worker-test-token-0123456789'
    db = await migratedDb(); const fake = createFakeSupabase(db); setTestAdminClient(fake); admin = fake as unknown as SupabaseClient
    actor = await adminUser(db); brand = await brandId(db)
    await rows(db, `insert into social_workers(worker_id,capabilities) values('worker',ARRAY['native-v1'])`)
  })
  after(async () => { setTestAdminClient(null); setTestAdmin(null); await db?.close() })

  it('every account action and the OAuth callback require verified admin authentication', async () => {
    setTestAdmin(null)
    assert.equal((await connectNativeAccount({ platform: 'devto', brandId: brand, secrets: { apiKey: 'fake' } })).ok, false)
    assert.equal((await disconnectNativeAccount(randomUUID())).ok, false)
    assert.equal((await startNativeOAuth({ platform: 'x', brandId: brand })).ok, false)
    assert.equal((await selectNativeDestination({ id: randomUUID(), index: 0 })).ok, false)
    assert.equal((await getTikTokCreator(randomUUID())).ok, false)
    assert.equal((await resolveNativePublication({ jobId: randomUUID(), found: false, remoteUrl: '', note: 'Verificat' })).ok, false)
    assert.equal((await callback(new Request('http://localhost:3000/api/native/callback?state=invalid'))).status, 403)
    assert.equal((await POST(new Request('http://localhost/api/worker/social/v1/deliveries/test/native', { method: 'POST' }), { params: Promise.resolve({ id: randomUUID() }) })).status, 401)
  })
  it('discovers only public summaries, encrypts candidates and consumes the selection once for its actor', async () => {
    const account: NativeAccount = { platform: 'devto', remoteId: 'native-example', displayName: 'Example', metadata: {}, credentials: { secrets: { apiKey: 'never-public-secret' } } }
    const id = await storeNativeCandidates(admin, actor, brand, [account])
    const [saved] = await rows(db, 'select * from social_native_candidates where id=$1', [id])
    assert.ok(!JSON.stringify(saved).includes('never-public-secret'))
    const other = await adminUser(db, 'other@example.test')
    await assert.rejects(connectNativeCandidate(admin, other, id, 0), /OAUTH_EXPIRED/)
    const connected = await connectNativeCandidate(admin, actor, id, 0)
    const [credentials] = await rows(db, 'select encrypted from social_native_credentials where account_id=$1', [connected])
    assert.ok(!credentials.encrypted.includes('never-public-secret'))
    await assert.rejects(connectNativeCandidate(admin, actor, id, 0), /OAUTH_EXPIRED/)
    assert.equal((await rows(db, 'select encrypted from social_native_candidates where id=$1', [id]))[0].encrypted, 'x'.repeat(40))
  })
  it('allows one refresh owner and prevents an expired owner or disconnect from replacing credentials', async () => {
    const account = await connect(); const first = randomUUID(); const second = randomUUID()
    const claim = async (owner: string, at: string) => (await rows(db, `select social_native_refresh_claim($1,1,$2,'worker',$3) as changed`, [account, owner, at]))[0].changed
    assert.equal(await claim(first, '2030-01-01T00:00:00Z'), true)
    assert.equal(await claim(second, '2030-01-01T00:00:01Z'), false)
    assert.equal(await claim(second, '2030-01-01T00:03:00Z'), true)
    const finish = async (owner: string) => (await rows(db, `select social_native_refresh_finish($1,1,$2,'worker',$3,null,null) as changed`, [account, owner, envelope]))[0].changed
    assert.equal(await finish(first), false)
    await rows(db, 'select social_native_disconnect($1,$2)', [account, actor])
    assert.equal(await finish(second), false)
  })
  it('native YouTube is automatic while historical YouTube keeps its manual constraint', async () => {
    const account = await connect('youtube')
    assert.deepEqual((await rows(db, 'select mode,status,paused,rules from social_accounts where id=$1', [account]))[0], { mode: 'auto', status: 'connected', paused: true, rules: { native: true } })
    await assert.rejects(rows(db, `insert into social_accounts(platform,mode,status,postiz_integration_id,display_name) values('youtube','auto','connected','legacy-id','Example')`), /MANUAL_ONLY/)
  })
  it('does not offer native jobs to a worker without the new capability', async () => {
    const account = await connect()
    await rows(db, `select social_admin_update_account($1,'{"paused":false}', $2)`, [account, actor])
    const created = await approvedPost(db, brand, actor, account)
    const [{ claimed }] = await rows(db, `select social_claim_deliveries('old-worker',5,true) as claimed`)
    assert.deepEqual(claimed.jobs, [])
    const [{ native }] = await rows(db, `select social_claim_deliveries('worker',5,true) as native`)
    assert.ok(native.jobs.some((job: { job_id: string }) => job.job_id === created.job))
  })
  it('checks the final-write gate and requires an aged, audited confirmation before retrying uncertain writes', async () => {
    const account = await connect()
    await rows(db, `select social_admin_update_account($1,'{"paused":false}', $2)`, [account, actor])
    const { job } = await approvedPost(db, brand, actor, account)
    await rows(db, `select social_claim_deliveries('worker',5,true)`)
    await rows(db, `select social_job_submitting($1,'worker',1,true)`, [job])
    const [{ destination_hash: hash }] = await rows(db, 'select destination_hash from social_destinations where id=(select destination_id from social_delivery_jobs where id=$1)', [job])
    const nonce = randomUUID()
    await rows(db, `select social_native_begin_publication($1,'worker',1,$2,$3,$4,true)`, [job, nonce, nativeRecordKey(), hash])
    const gate = async () => (await rows(db, `select social_native_publication_gate($1,$2,'worker',1,$3,true) as r`, [job, nonce, hash]))[0].r
    assert.equal((await gate()).ok, true)
    await rows(db, `select social_admin_update_account($1,'{"paused":true}', $2)`, [account, actor])
    assert.equal((await gate()).ok, false)
    await rows(db, `select social_native_wait($1,'worker',1)`, [job])
    await assert.rejects(rows(db, `select social_native_resolve($1,$2,false,null,'Am verificat contul')`, [job, actor]), /TOO_EARLY/)
    await rows(db, `update social_native_publications set created_at=now()-interval '31 minutes' where job_id=$1`, [job])
    await rows(db, `select social_native_resolve($1,$2,false,null,'Am verificat contul si istoricul publicarii')`, [job, actor])
    const [saved] = await rows(db, 'select status,last_error_code from social_delivery_jobs where id=$1', [job])
    assert.equal(saved.status, 'failed'); assert.equal(saved.last_error_code, 'NATIVE_CONFIRMED_ABSENT')
    const [{ changed }] = await rows(db, `select social_native_finish_publication($1,$2,'published','late','https://example.test/late','{}',null,null) as changed`, [job, nonce])
    assert.equal(changed, false)
  })
  it('denies browser roles access to pending tokens and publication sessions', async () => {
    await db.exec('set role authenticated')
    try {
      for (const table of ['social_native_candidates', 'social_native_publications']) await assert.rejects(rows(db, `select * from ${table}`), /permission denied/)
    } finally { await db.exec('reset role') }
  })
})
