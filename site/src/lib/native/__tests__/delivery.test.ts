import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import type { SupabaseClient } from '@supabase/supabase-js'
import { migratedDb } from '../../testing/pglite-db.ts'
import { createFakeSupabase } from '../../testing/fake-supabase.ts'
import { adminUser, approvedPost, brandId, rows } from '../../testing/social-fixtures.ts'
import { sealCredentials, openCredentials } from '../credentials.ts'
import { NativeProviderError } from '../http.ts'
import { accountCredentialContext, nativeDelivery, nativeRecordKey } from '../server.ts'
import type { NativeProvider } from '../types.ts'

let db: PGlite
let admin: SupabaseClient
let actor: string
let brand: string
let seq = 0
const worker = 'native-test-worker'

async function job() {
  const remote = `native-remote-${++seq}`
  const encrypted = sealCredentials({ secrets: { apiKey: 'fake-private-key' } }, accountCredentialContext('devto', remote, ''))
  const [{ id: account }] = await rows(db, `select social_native_connect('devto',$1,'','Example',null,null,$2,$3,'{}',null,$4) as id`, [remote, brand, encrypted, actor])
  await rows(db, `select social_admin_update_account($1,'{"paused":false}', $2)`, [account, actor])
  const created = await approvedPost(db, brand, actor, account)
  const [{ claimed }] = await rows(db, 'select social_claim_deliveries($1,5,true) as claimed', [worker])
  assert.ok(claimed.jobs.some((item: { job_id: string }) => item.job_id === created.job))
  await rows(db, 'select social_job_submitting($1,$2,1,true)', [created.job, worker])
  return { ...created, account }
}
function provider(publish: NativeProvider['publish']): NativeProvider { return { platform: 'devto', connect: async () => [], publish } }

describe('direct delivery on temporary local SQL and fake providers', () => {
  before(async () => {
    process.env.DB_MODE = 'local'
    process.env.LOCAL_AUTH_SECRET = 'native-delivery-test-only-secret-0123456789'
    process.env.SOCIAL_PUBLISHING_ENABLED = 'true'
    db = await migratedDb(); admin = createFakeSupabase(db) as unknown as SupabaseClient
    actor = await adminUser(db); brand = await brandId(db)
    await rows(db, `insert into social_workers(worker_id,capabilities) values($1,ARRAY['native-v1'])`, [worker])
  })
  after(async () => { await db?.close() })

  it('publishes directly with no Postiz identity and records an atomic audit trail', async () => {
    const created = await job()
    let writes = 0
    const result = await nativeDelivery(admin, worker, created.job, 1, 'publish', { provider: () => provider(async (_ctx, input) => {
      writes++; assert.equal(input.account.credentials.secrets.apiKey, 'fake-private-key')
      return { remoteId: 'article-1', remoteUrl: 'https://example.test/article-1', status: 'published' }
    }) })
    assert.equal(result.ok, true)
    assert.equal(writes, 1)
    const [saved] = await rows(db, 'select status,remote_url,postiz_post_id from social_delivery_jobs where id=$1', [created.job])
    assert.deepEqual(saved, { status: 'published', remote_url: 'https://example.test/article-1', postiz_post_id: null })
    const logs = await rows(db, 'select details from social_activity_log where job_id=$1', [created.job])
    assert.ok(logs.length >= 2)
    assert.ok(!JSON.stringify(logs).includes('fake-private-key'))
  })

  it('holds a lost remote response in reconciliation without resending', async () => {
    const created = await job()
    let writes = 0
    const deps = { provider: () => provider(async () => { writes++; throw new NativeProviderError('UNKNOWN_RESULT', 0, true) }) }
    assert.equal((await nativeDelivery(admin, worker, created.job, 1, 'publish', deps)).ok, true)
    await rows(db, `update social_delivery_jobs set lease_owner=$2,lease_expires_at=now()+interval '1 minute' where id=$1`, [created.job, worker])
    assert.equal((await nativeDelivery(admin, worker, created.job, 1, 'check', deps)).ok, true)
    assert.equal(writes, 1)
    const [saved] = await rows(db, 'select status,last_error_code from social_delivery_jobs where id=$1', [created.job])
    assert.equal(saved.status, 'reconciling')
  })

  it('fences concurrent executions and allows a late result to be recovered', async () => {
    const created = await job()
    const [{ destination_hash: hash }] = await rows(db, 'select destination_hash from social_destinations where id=(select destination_id from social_delivery_jobs where id=$1)', [created.job])
    const nonce = randomUUID()
    const begin = async (owner: string) => (await rows(db, 'select social_native_begin_publication($1,$2,1,$3,$4,$5,true) as r', [created.job, worker, owner, nativeRecordKey(), hash]))[0].r
    assert.equal((await begin(nonce)).send, true)
    assert.equal((await begin(randomUUID())).send, false)
    await rows(db, `update social_delivery_jobs set status='reconciling',lease_owner=null,lease_expires_at=null where id=$1`, [created.job])
    const finish = async (owner: string) => (await rows(db, `select social_native_finish_publication($1,$2,'published','remote-late','https://example.test/late','{}',null,null) as changed`, [created.job, owner]))[0].changed
    assert.equal(await finish(randomUUID()), false)
    assert.equal(await finish(nonce), true)
    await rows(db, `update social_delivery_jobs set lease_owner=$2,lease_expires_at=now()+interval '1 minute' where id=$1`, [created.job, worker])
    assert.equal((await nativeDelivery(admin, worker, created.job, 1, 'check')).ok, true)
    assert.equal((await rows(db, 'select status from social_delivery_jobs where id=$1', [created.job]))[0].status, 'published')
  })

  it('rechecks account pause after the worker entered submitting', async () => {
    const created = await job()
    await rows(db, `select social_admin_update_account($1,'{"paused":true}', $2)`, [created.account, actor])
    let writes = 0
    const result = await nativeDelivery(admin, worker, created.job, 1, 'publish', { provider: () => provider(async () => { writes++; return { remoteId: 'wrong', status: 'published' } }) })
    assert.equal(result.code, 'PUBLISHING_PAUSED')
    assert.equal(writes, 0)
  })

  it('encrypts an upload checkpoint, retains it after a lost answer and recovers without another publication', async () => {
    const created = await job()
    let writes = 0
    const fake: NativeProvider = { ...provider(async (ctx) => {
      writes++
      await ctx.checkpoint!({ remoteId: 'upload-session', status: 'processing', metadata: { phase: 'upload' }, privateData: { sessionUrl: 'https://example.test/upload?private=capability' } })
      throw new NativeProviderError('UNKNOWN_RESULT', 0, true)
    }), poll: async (_ctx, _account, publication) => {
      assert.equal(publication.privateData!.sessionUrl, 'https://example.test/upload?private=capability')
      return { remoteId: 'recovered-video', remoteUrl: 'https://example.test/recovered-video', status: 'published' }
    } }
    await nativeDelivery(admin, worker, created.job, 1, 'publish', { provider: () => fake })
    const [checkpoint] = await rows(db, 'select metadata from social_native_publications where job_id=$1', [created.job])
    assert.ok(!JSON.stringify(checkpoint).includes('private=capability'))
    assert.equal(openCredentials(checkpoint.metadata._private, `publication:${created.job}`).secrets.sessionUrl, 'https://example.test/upload?private=capability')
    await rows(db, `update social_delivery_jobs set lease_owner=$2,lease_expires_at=now()+interval '1 minute' where id=$1`, [created.job, worker])
    await nativeDelivery(admin, worker, created.job, 1, 'check', { provider: () => fake })
    assert.equal(writes, 1)
    assert.equal((await rows(db, 'select status from social_delivery_jobs where id=$1', [created.job]))[0].status, 'published')
    assert.equal((await rows(db, 'select metadata from social_native_publications where job_id=$1', [created.job]))[0].metadata._private, undefined)
  })

  it('record keys remain unique and sortable within one millisecond', () => {
    const keys = Array.from({ length: 2000 }, () => nativeRecordKey())
    assert.equal(new Set(keys).size, keys.length)
    assert.ok(keys.every((key) => /^[234567a-z]{13}$/.test(key)))
    assert.deepEqual(keys, [...keys].sort())
  })
})
