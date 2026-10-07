/**
 * Accounts screen (PRD F1, W3): every account state can be changed through
 * the server actions, on PGlite, with the rules of migration 0005. Synced
 * channels come from the fake worker through the real /accounts/sync route.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PGlite } from '@electric-sql/pglite'
import { migratedDb } from '../../testing/pglite-db.ts'
import { createFakeSupabase } from '../../testing/fake-supabase.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { setTestAdmin } from '../../testing/auth-shim.ts'
import { routeFetch } from '../../testing/route-fetch.ts'
import { adminUser, brandId, createAccount, resetSocial, rows, scheduleAndApprove } from '../../testing/social-fixtures.ts'
import { WorkerApi } from '../fake/worker-api-client.ts'
import { FAKE_INTEGRATIONS, syncFakeAccounts } from '../fake/fake-worker.ts'
import { createManualAccount, deleteManualAccount, updateAccount } from '../accounts-actions.ts'
import { getWorkerHealth, listAdminAccounts } from '../accounts-queries.ts'
import { STATUSES_FOR_MODE, publishBlockers } from '../accounts.ts'
import { ACCOUNT_STATUSES } from '../constants.ts'

const TOKEN = 'accounts-test-token-0123456789abcdef'
let db: PGlite
let brand: string
let otherBrand: string
let admin: { userId: string; email: string }
let api: WorkerApi

const account = async (id: string) => (await rows(db, `select * from social_accounts where id = $1`, [id]))[0]
const synced = async (integration: string) =>
  (await rows(db, `select id from social_accounts where postiz_integration_id = $1`, [integration]))[0].id as string
const errorOf = (r: { ok: boolean; error?: string }) => r.error ?? ''

async function draftPost(accounts: string[], scheduledAt: string | null = null): Promise<string> {
  const [{ id }] = await rows(db, `select social_create_post($1::jsonb, $2::jsonb, $3::jsonb) as id`, [
    JSON.stringify({ brand_id: brand, kind: 'social', title: 'Test', created_by: admin.userId }),
    JSON.stringify({ canonical_text: 'Salut' }),
    JSON.stringify(accounts.map((a) => ({ account_id: a, text: 'Salut', settings: {}, scheduled_at: scheduledAt }))),
  ])
  return id
}

describe('accounts screen: actions and queries (W3)', () => {
  before(async () => {
    db = await migratedDb()
    setTestAdminClient(createFakeSupabase(db))
    brand = await brandId(db)
    otherBrand = await brandId(db, 'comets-of-web3')
    admin = { userId: await adminUser(db), email: 'admin@example.test' }
    api = new WorkerApi({ baseUrl: 'http://127.0.0.1:3000', token: TOKEN, workerId: 'acc-1', fetch: routeFetch })
  })
  after(async () => {
    setTestAdminClient(null)
    setTestAdmin(null)
    await db.close()
  })
  beforeEach(async () => {
    process.env.WORKER_TOKEN = TOKEN
    setTestAdmin(admin)
    await resetSocial(db)
  })

  it('refuses every action without an admin session', async () => {
    const id = await createAccount(db, brand, 'x', { paused: true })
    setTestAdmin(null)
    assert.equal((await updateAccount(id, { paused: false })).ok, false)
    assert.equal((await createManualAccount({ platform: 'substack', brandId: brand, displayName: 'Blog' })).ok, false)
    assert.equal((await deleteManualAccount(id)).ok, false)
    assert.equal((await account(id)).paused, true)
    assert.equal((await rows(db, `select 1 from social_accounts`)).length, 1)
  })

  it('synced channels arrive unassigned and paused; assigning and unpausing happens here', async () => {
    assert.equal((await syncFakeAccounts(api)).status, 200)
    const listed = await listAdminAccounts()
    assert.equal(listed.length, FAKE_INTEGRATIONS.length)
    assert.ok(listed.every((a) => a.brand_id === null && a.paused && (a.platform === 'youtube' ? a.mode === 'manual' && a.status === 'manual' : a.mode === 'auto' && a.status === 'connected')), 'YouTube syncs as a manual account (needs video); every other channel is automatic')
    assert.ok(listed.every((a) => publishBlockers(a).includes('fara brand')))

    const x = await synced('fake-x')
    assert.match(errorOf(await updateAccount(x, { paused: false })), /brandul/)
    const r = await updateAccount(x, { brand_id: brand, paused: false })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.deepEqual((r as { changed: string[] }).changed, ['brand_id', 'paused'])
    const row = await account(x)
    assert.equal(row.brand_id, brand)
    assert.equal(row.paused, false)
    assert.deepEqual(publishBlockers({ brand_id: row.brand_id, mode: row.mode, status: row.status, paused: row.paused,
      postiz_integration_id: row.postiz_integration_id, postiz_disabled: row.postiz_disabled, platform: 'x' }), [])

    const [log] = await rows(db, `select action, account_id, actor_email, details from social_activity_log`)
    assert.equal(log.action, 'social.account_updated')
    assert.equal(log.account_id, x)
    assert.equal(log.actor_email, 'admin@example.test')
    assert.deepEqual(log.details.changed, ['brand_id', 'paused'])
    assert.deepEqual(log.details.after, { brand_id: brand, paused: false })

    // Nothing changed: no update, no log row.
    assert.deepEqual((await updateAccount(x, { brand_id: brand, paused: false }) as { changed: string[] }).changed, [])
    assert.equal((await rows(db, `select 1 from social_activity_log`)).length, 1)

    // Unassigning pauses it again.
    assert.equal((await updateAccount(x, { brand_id: null })).ok, true)
    assert.equal((await account(x)).paused, true)
  })

  it('every status and both modes can be set, and only in combinations that make sense', async () => {
    await syncFakeAccounts(api)
    const li = await synced('fake-linkedin')
    await updateAccount(li, { brand_id: brand })
    for (const status of STATUSES_FOR_MODE.auto) {
      const r = await updateAccount(li, { status })
      assert.equal(r.ok, true, `${status}: ${JSON.stringify(r)}`)
      assert.equal((await account(li)).status, status)
    }
    assert.match(errorOf(await updateAccount(li, { status: 'manual' })), /nu se potriveste/)

    // LinkedIn before API approval: manual mode; status follows the mode.
    assert.equal((await updateAccount(li, { mode: 'manual' })).ok, true)
    assert.deepEqual([(await account(li)).mode, (await account(li)).status], ['manual', 'manual'])
    assert.equal((await updateAccount(li, { status: 'approval_pending' })).ok, true)
    assert.match(errorOf(await updateAccount(li, { status: 'connected' })), /nu se potriveste/)
    assert.match(errorOf(await updateAccount(li, { mode: 'manual', status: 'reconnect_required' })), /nu se potriveste/)
    assert.equal((await updateAccount(li, { mode: 'auto' })).ok, true)
    assert.deepEqual([(await account(li)).mode, (await account(li)).status], ['auto', 'connected'])
    assert.equal((await updateAccount(li, { mode: 'manual', status: 'approval_pending' })).ok, true)
    assert.equal((await account(li)).status, 'approval_pending')

    // Every status of the PRD is reachable from these actions.
    const reached = new Set((await rows(db, `select distinct (details->'after'->>'status') as s from social_activity_log where details->'after' ? 'status'`)).map((r) => r.s))
    for (const s of ACCOUNT_STATUSES) assert.ok(reached.has(s), `status ${s} never set`)

    // Pause and unpause.
    assert.equal((await updateAccount(li, { paused: true })).ok, true)
    assert.equal((await account(li)).paused, true)
    assert.equal((await updateAccount(li, { paused: false })).ok, true)
    assert.equal((await account(li)).paused, false)

    // Bad input never reaches the database.
    assert.match(errorOf(await updateAccount(li, { status: 'gone' as never })), /stare/)
    assert.match(errorOf(await updateAccount(li, { mode: 'robot' as never })), /automat sau manual/)
    assert.match(errorOf(await updateAccount(li, { brand_id: 'nope' })), /brand/)
    assert.match(errorOf(await updateAccount('00000000-0000-4000-8000-000000000000', { paused: true })), /nu mai exista/)
  })

  it('auto needs a Postiz channel; Substack and Product Hunt stay manual', async () => {
    const r = await createManualAccount({ platform: 'linkedin-page', brandId: brand, displayName: 'Pagina LinkedIn (test)' })
    assert.equal(r.ok, true)
    const id = (r as { accountId: string }).accountId
    assert.match(errorOf(await updateAccount(id, { mode: 'auto' })), /canal Postiz/)

    const [{ id: sub }] = await rows(
      db,
      `insert into social_accounts (brand_id, platform, mode, status, postiz_integration_id, display_name)
       values ($1, 'substack', 'manual', 'manual', 'odd-substack', 'Substack') returning id`,
      [brand]
    )
    assert.match(errorOf(await updateAccount(sub, { mode: 'auto' })), /raman manuale/)
  })

  it('daily cap: 1 to 5, and never below what is already scheduled on a coming day', async () => {
    const x = await createAccount(db, brand, 'x')
    for (const bad of [0, 6, 2.5]) assert.match(errorOf(await updateAccount(x, { daily_cap: bad })), /intre 1 si 5/)
    assert.equal((await updateAccount(x, { daily_cap: 3 })).ok, true)
    assert.equal((await account(x)).daily_cap, 3)
    assert.equal((await updateAccount(x, { daily_cap: 5 })).ok, true)

    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000)
    for (let i = 0; i < 3; i++) await scheduleAndApprove(db, await draftPost([x]), admin.userId, new Date(tomorrow.getTime() + i * 60_000))
    const refused = errorOf(await updateAccount(x, { daily_cap: 2 }))
    assert.match(refused, /sunt deja 3 postari programate/)
    assert.equal((await account(x)).daily_cap, 5)
    assert.equal((await updateAccount(x, { daily_cap: 3 })).ok, true)
  })

  it('mode and brand changes wait until the account has no jobs waiting', async () => {
    const x = await createAccount(db, brand, 'x')
    await scheduleAndApprove(db, await draftPost([x]), admin.userId, new Date(Date.now() + 3600_000))
    assert.match(errorOf(await updateAccount(x, { mode: 'manual' })), /1 postari programate/)
    assert.match(errorOf(await updateAccount(x, { brand_id: otherBrand })), /postari programate/)
    // Cap, pause and status stay changeable.
    assert.equal((await updateAccount(x, { paused: true, status: 'reconnect_required' })).ok, true)
    await rows(db, `update social_delivery_jobs set status = 'cancelled'`)
    assert.equal((await updateAccount(x, { mode: 'manual' })).ok, true)
    assert.equal((await updateAccount(x, { brand_id: otherBrand })).ok, true)
  })

  it('manual-only accounts: create with an editor link, edit, delete while unused', async () => {
    const r = await createManualAccount({ platform: 'substack', brandId: brand, displayName: '  Blog Substack (test) ' })
    assert.equal(r.ok, true, JSON.stringify(r))
    const id = (r as { accountId: string }).accountId
    const row = await account(id)
    assert.deepEqual(
      { mode: row.mode, status: row.status, paused: row.paused, cap: row.daily_cap, editor: row.open_editor_url, name: row.display_name, postiz: row.postiz_integration_id },
      { mode: 'manual', status: 'manual', paused: false, cap: 5, editor: 'https://substack.com/', name: 'Blog Substack (test)', postiz: null }
    )
    assert.equal((await rows(db, `select action from social_activity_log`))[0].action, 'social.account_created')

    assert.equal(
      (await updateAccount(id, { display_name: 'Blog nou', open_editor_url: 'https://example.substack.com/publish/post', profile_url: 'https://example.substack.com' })).ok,
      true
    )
    const edited = await account(id)
    assert.equal(edited.display_name, 'Blog nou')
    assert.equal(edited.open_editor_url, 'https://example.substack.com/publish/post')
    assert.match(errorOf(await updateAccount(id, { open_editor_url: 'javascript:alert(1)' })), /https/)
    assert.match(errorOf(await updateAccount(id, { display_name: '   ' })), /obligatoriu/)
    assert.equal((await updateAccount(id, { open_editor_url: '' })).ok, true)
    assert.equal((await account(id)).open_editor_url, null)

    assert.match(errorOf(await createManualAccount({ platform: 'substack', brandId: brand, displayName: '' })), /obligatoriu/)
    assert.match(errorOf(await createManualAccount({ platform: 'myspace' as never, brandId: brand, displayName: 'x' })), /platforma/)
    assert.match(errorOf(await createManualAccount({ platform: 'substack', brandId: brand, displayName: 'x', dailyCap: 9 })), /1 si 5/)

    // In use: kept.
    await draftPost([id])
    assert.match(errorOf(await deleteManualAccount(id)), /folosit/)
    const listed = (await listAdminAccounts()).find((a) => a.id === id)!
    assert.equal(listed.used, true)

    const spare = (await createManualAccount({ platform: 'producthunt', brandId: brand, displayName: 'Maker' })) as { accountId: string }
    assert.equal((await listAdminAccounts()).find((a) => a.id === spare.accountId)!.used, false)
    assert.equal((await deleteManualAccount(spare.accountId)).ok, true)
    assert.equal((await rows(db, `select 1 from social_accounts where id = $1`, [spare.accountId])).length, 0)
    assert.equal((await rows(db, `select 1 from social_activity_log where action = 'social.account_deleted'`)).length, 1)
  })

  it('name and profile of a synced account belong to Postiz, and it is not deleted from here', async () => {
    await syncFakeAccounts(api)
    const x = await synced('fake-x')
    assert.match(errorOf(await updateAccount(x, { display_name: 'Alt nume' })), /sincronizare/)
    assert.match(errorOf(await deleteManualAccount(x)), /pauza/)
    assert.equal((await updateAccount(x, { open_editor_url: 'https://x.com/compose/post' })).ok, true)
  })

  it('worker health: last seen and last account sync against 5 and 30 minutes', async () => {
    const none = await getWorkerHealth()
    assert.deepEqual([none.seen, none.sync], ['never', 'never'])
    await syncFakeAccounts(api)
    const fresh = await getWorkerHealth()
    assert.deepEqual([fresh.seen, fresh.sync], ['ok', 'ok'])
    assert.equal(fresh.workers[0].worker_id, 'acc-1')
    await rows(db, `update social_workers set last_seen_at = now() - interval '6 minutes', last_account_sync_at = now() - interval '29 minutes'`)
    const later = await getWorkerHealth()
    assert.deepEqual([later.seen, later.sync], ['stale', 'ok'])
    await rows(db, `update social_workers set last_account_sync_at = now() - interval '31 minutes'`)
    assert.equal((await getWorkerHealth()).sync, 'stale')
    process.env.SOCIAL_PUBLISHING_ENABLED = 'true'
    assert.equal((await getWorkerHealth()).publishing_enabled, true)
    delete process.env.SOCIAL_PUBLISHING_ENABLED
    assert.equal((await getWorkerHealth()).publishing_enabled, false)
  })

  it('sync preserves manual approval status even when Postiz asks for reconnection', async () => {
    await syncFakeAccounts(api)
    const li = await synced('fake-linkedin')
    assert.equal((await updateAccount(li, { mode: 'manual', status: 'approval_pending' })).ok, true)
    await syncFakeAccounts(api, { refreshNeeded: ['fake-linkedin'] })
    assert.equal((await account(li)).status, 'approval_pending')
    assert.equal((await updateAccount(li, { status: 'manual' })).ok, true)
    await syncFakeAccounts(api, { refreshNeeded: ['fake-linkedin'] })
    assert.equal((await account(li)).status, 'manual')
    assert.equal((await updateAccount(li, { mode: 'auto' })).ok, true)
    await syncFakeAccounts(api, { refreshNeeded: ['fake-linkedin'] })
    assert.equal((await account(li)).status, 'reconnect_required')
  })
})
