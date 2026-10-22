import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import { migratedDb } from '../../testing/pglite-db.ts'
import { adminUser, brandId, rows } from '../../testing/social-fixtures.ts'
import { newOAuthAttempt } from '../oauth.ts'
import { NATIVE_PLATFORMS } from '../types.ts'

let db: PGlite
let actor: string
let brand: string
const encrypted = 'v1.example-ciphertext-for-tests-only-'.repeat(3)

async function connect(remoteId: string, instance = ''): Promise<string> {
  const [result] = await rows(db, `select social_native_connect(
    'bluesky', $1, $2, 'Example account', 'https://example.test/profile', null,
    $3, $4, '{}'::jsonb, null, $5) as id`, [remoteId, instance, brand, encrypted, actor])
  return result.id
}

describe('native connections on a temporary migrated database', () => {
  before(async () => { db = await migratedDb(); actor = await adminUser(db); brand = await brandId(db) })
  after(async () => { await db?.close() })

  it('keeps the SQL and TypeScript platform inventories consistent', async () => {
    const [result] = await rows(db, 'select social_native_platforms() as platforms')
    assert.deepEqual([...result.platforms].sort(), [...NATIVE_PLATFORMS].sort())
  })

  it('connects directly with no Postiz ID, starts paused and records no secret in activity', async () => {
    const id = await connect('did:example:account-1')
    const [account] = await rows(db, 'select * from social_accounts where id = $1', [id])
    assert.equal(account.publishing_backend, 'native')
    assert.equal(account.postiz_integration_id, null)
    assert.equal(account.mode, 'auto')
    assert.equal(account.paused, true)
    const [credential] = await rows(db, 'select * from social_native_credentials where account_id = $1', [id])
    assert.equal(credential.encrypted, encrypted)
    const [log] = await rows(db, 'select * from social_activity_log where account_id = $1', [id])
    assert.equal(log.action, 'social.native_connected')
    assert.ok(!JSON.stringify(log).includes(encrypted))
    await rows(db, `select social_admin_update_account($1, '{"paused":false}'::jsonb, $2)`, [id, actor])
  })

  it('creates API-connected YouTube, GitHub and Stack Exchange accounts as automatic without changing historical manual accounts', async () => {
    for (const platform of ['youtube', 'github', 'stackexchange']) {
      const [{ id }] = await rows(db, `select social_native_connect($1,'api-example','','Example',null,null,$2,$3,'{}',null,$4) as id`, [platform, brand, encrypted, actor])
      assert.deepEqual((await rows(db, 'select mode,status,paused from social_accounts where id=$1', [id]))[0], { mode: 'auto', status: 'connected', paused: true })
      await rows(db, `select social_admin_update_account($1,'{"mode":"manual","status":"manual"}',$2)`, [id, actor])
      await rows(db, `select social_admin_update_account($1,'{"mode":"auto","status":"connected"}',$2)`, [id, actor])
      await assert.rejects(rows(db, `insert into social_accounts(platform,mode,status,display_name) values($1,'auto','connected','Legacy')`, [platform]), /MANUAL_ONLY/)
    }
  })

  it('reconnects one identity without duplicating the account, changing its brand or unpausing it', async () => {
    const first = await connect('did:example:account-2')
    const second = await connect('did:example:account-2')
    assert.equal(first, second)
    const [credential] = await rows(db, 'select version from social_native_credentials where account_id = $1', [first])
    assert.equal(credential.version, 2)
    const [account] = await rows(db, 'select brand_id, paused from social_accounts where id = $1', [first])
    assert.equal(account.brand_id, brand)
    assert.equal(account.paused, true)
  })

  it('uses optimistic credential rotation and does not resurrect disconnected credentials', async () => {
    const id = await connect('did:example:account-3')
    const rotate = async (version: number) => (await rows(db, 'select social_native_rotate_credentials($1,$2,$3,null,null,$4) as changed', [id, version, encrypted, 'test-worker']))[0].changed
    assert.equal(await rotate(1), true)
    assert.equal(await rotate(1), false)
    await rows(db, 'select social_native_disconnect($1,$2)', [id, actor])
    assert.equal(await rotate(2), false)
    const [account] = await rows(db, 'select paused, status from social_accounts where id = $1', [id])
    assert.deepEqual(account, { paused: true, status: 'reconnect_required' })
  })

  it('binds expiring OAuth attempts to the actor and browser and consumes them once', async () => {
    const attempt = newOAuthAttempt()
    const id = randomUUID()
    const timestamp = '2030-01-01T00:00:00Z'
    await rows(db, `select social_native_oauth_begin($1,$2,$3,$4,'bluesky',$5,$6,'http://localhost:3000/api/native/callback',$7)`, [id, attempt.stateHash, attempt.browserHash, actor, brand, encrypted, timestamp])
    await assert.rejects(rows(db, 'select social_native_oauth_consume($1,$2,$3,$4)', [attempt.stateHash, '0'.repeat(64), actor, timestamp]), /OAUTH_EXPIRED/)
    const [result] = await rows(db, 'select social_native_oauth_consume($1,$2,$3,$4) as attempt', [attempt.stateHash, attempt.browserHash, actor, timestamp])
    assert.equal(result.attempt.id, id)
    await assert.rejects(rows(db, 'select social_native_oauth_consume($1,$2,$3,$4)', [attempt.stateHash, attempt.browserHash, actor, timestamp]), /OAUTH_EXPIRED/)
    const expired = newOAuthAttempt()
    await rows(db, `select social_native_oauth_begin($1,$2,$3,$4,'bluesky',$5,$6,'http://localhost:3000/api/native/callback',$7)`, [randomUUID(), expired.stateHash, expired.browserHash, actor, brand, encrypted, timestamp])
    await assert.rejects(rows(db, 'select social_native_oauth_consume($1,$2,$3,$4)', [expired.stateHash, expired.browserHash, actor, '2030-01-01T00:11:00Z']), /OAUTH_EXPIRED/)
  })

  it('rejects actorless mutations and prevents browser roles from reading credentials', async () => {
    await assert.rejects(rows(db, `select social_native_connect('bluesky','forbidden','','Example',null,null,$1,$2,'{}',null,null)`, [brand, encrypted]), /ACTOR_REQUIRED/)
    await db.exec('set role authenticated')
    try {
      await assert.rejects(rows(db, 'select * from social_native_credentials'), /permission denied/)
      await assert.rejects(rows(db, 'select * from social_native_oauth_attempts'), /permission denied/)
    } finally { await db.exec('reset role') }
  })
})
