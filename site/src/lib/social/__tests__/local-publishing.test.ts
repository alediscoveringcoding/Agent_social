/** Cross-stream acceptance on fresh disk-backed local data and real HTTP.
 * The child uses the production worker; every AI and platform stays offline.
 */
import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PGlite } from '@electric-sql/pglite'
import { getLocalDb } from '../../local/db.ts'
import { createLocalAdminClient } from '../../local/admin-client.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { setTestAdmin } from '../../testing/auth-shim.ts'
import { adminUser, brandId, resetSocial, rows } from '../../testing/social-fixtures.ts'
import { routeFetch } from '../../testing/route-fetch.ts'
import { WorkerApi } from '../fake/worker-api-client.ts'
import { runFakeGeneratorOnce } from '../fake/fake-generator.ts'
import { runFakeWorkerOnce } from '../fake/fake-worker.ts'
import { createGenerationRequest, saveDraft } from '../actions.ts'
import { getDraft, listDrafts } from '../queries.ts'
import { approvePost } from '../approval-actions.ts'
import { getPost } from '../approval-queries.ts'
import { generateCards } from '../media-actions.ts'
import { createManualAccount, updateAccount } from '../accounts-actions.ts'
import { getManualJob } from '../handoff-queries.ts'
import { markManualPublished } from '../handoff-actions.ts'
import { getOverview } from '../overview-queries.ts'
import { getCalendarWeek } from '../calendar-queries.ts'
import { resolveWeek } from '../calendar.ts'
import { toLocalInputs } from '../time.ts'
import { checkDestinations, type ApprovalDestination } from '../approval.ts'
import { GET as download } from '@/app/api/media/[id]/route'

let db: PGlite
let dir: string
let server: Server
let base: string
let api: WorkerApi
let brand: string
let account: string
let actor: { userId: string; email: string }
let postizCalls = 0
let mediaDownloads = 0
const token = 'integration-token-0123456789abcdef0123456789'
const spec = { template: 'mint' as const, headline: 'Pregateste declaratia', keyword: 'declaratia', stat: '16%', subline: 'Un pas simplu', alt_text: 'Card despre declaratie' }

async function createDraft(accounts = [account]) {
  const [{ id }] = await rows(db, 'select social_create_post($1::jsonb,$2::jsonb,$3::jsonb) as id', [
    JSON.stringify({ brand_id: brand, kind: 'social', title: 'Ghid', created_by: actor.userId }),
    JSON.stringify({ canonical_text: 'Un ghid clar.', figures: [] }),
    JSON.stringify(await Promise.all(accounts.map(async account_id => ({ account_id, text: 'Un ghid clar.', settings: (await rows(db, 'select platform from social_accounts where id=$1', [account_id]))[0].platform === 'substack' ? { title: 'Ghid' } : {} })))),
  ])
  return (await getDraft(id))!
}
async function removeFigureList(postId: string) {
  const draft = (await getDraft(postId))!
  const result = await saveDraft({ postId, baseRevisionId: draft.revision.id, edit: {
    title: 'Ghid clar', canonicalText: 'Un ghid clar.', figures: [],
    destinations: draft.destinations.map(d => ({ accountId: d.account_id, text: 'Un ghid clar.', settings: d.settings })),
  } })
  assert.equal(result.ok, true, JSON.stringify(result))
  return (await getDraft(postId))!
}
async function approve(postId: string, checked: boolean) {
  const draft = (await getDraft(postId))!
  const time = toLocalInputs(new Date(Date.now() + 120_000))
  return approvePost({ postId, revisionId: draft.revision.id, times: Object.fromEntries(draft.destinations.map(d => [d.account_id, time])), figuresChecked: checked })
}
async function makeDue(postId: string) {
  // Advance only fixture jobs instead of waiting for the chosen future slot.
  await db.query(`update social_delivery_jobs set run_at=now()-interval '1 second' where destination_id in
    (select d.id from social_destinations d join social_post_revisions r on r.id=d.revision_id where r.post_id=$1)`, [postId])
}

describe('local publishing across W1-W4', () => {
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'social-integration-'))
    Object.assign(process.env, { DB_MODE: 'local', LOCAL_DB_DIR: dir, MEDIA_SIGNING_SECRET: 'integration-signing-secret-0123456789abcdef', WORKER_TOKEN: token, SOCIAL_PUBLISHING_ENABLED: 'true' })
    db = await getLocalDb()
    setTestAdminClient(createLocalAdminClient())
    brand = await brandId(db)
    actor = { userId: await adminUser(db), email: 'admin@example.test' }
    server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value)
        const request = new Request(`${base}${req.url}`, { method: req.method, headers, ...(['GET', 'HEAD'].includes(req.method ?? 'GET') ? {} : { body: Buffer.concat(chunks) }) })
        let response: Response
        if (req.url?.startsWith('/postiz')) { postizCalls++; response = new Response('Unexpected Postiz call', { status: 500 }) }
        else if (new URL(request.url).pathname.startsWith('/api/media/')) {
          mediaDownloads++
          response = await download(request, { params: Promise.resolve({ id: new URL(request.url).pathname.split('/').at(-1)! }) })
        } else response = await routeFetch(request.url, { method: request.method, headers: request.headers, body: request.method === 'POST' ? await request.text() : undefined })
        res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
        res.end(Buffer.from(await response.arrayBuffer()))
      } catch (error) { res.writeHead(500); res.end(String(error)) }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    base = `http://127.0.0.1:${address.port}`
    api = new WorkerApi({ baseUrl: base, token, workerId: 'integration-fake' })
  })
  after(async () => {
    setTestAdminClient(null); setTestAdmin(null)
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    if (db) await db.close()
    if (dir) await rm(dir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    await resetSocial(db); setTestAdmin(actor)
    const sync = await api.post('/accounts/sync', { integrations: [{ postiz_integration_id: 'local-x', provider: 'x', name: 'Cont local', disabled: false, refresh_needed: false, rules: {} }], postiz_recent_posts: [] })
    assert.equal(sync.status, 200)
    account = (await rows(db, "select id from social_accounts where postiz_integration_id='local-x'"))[0].id
    assert.equal((await updateAccount(account, { brand_id: brand, paused: false })).ok, true)
    postizCalls = 0; mediaDownloads = 0
  })

  it('fake generator -> edit -> numeric card -> approval -> downloaded media -> published overview/calendar', async () => {
    const generation = await createGenerationRequest({ brandId: brand, source: { type: 'topic', topic: 'Declaratia', hooks: [] }, platforms: ['x'], count: 1, templates: ['mint'] })
    assert.equal(generation.ok, true)
    assert.equal((await runFakeGeneratorOnce(api))[0].status, 200)
    let draft = (await getDraft((await listDrafts())[0].id))!
    const cards = await generateCards({ postId: draft.id, baseRevisionId: draft.revision.id, spec })
    assert.equal(cards.ok, true, JSON.stringify(cards))
    draft = await removeFigureList(draft.id)
    const blocked = await approve(draft.id, false)
    assert.equal(blocked.ok, false)
    if (!blocked.ok) assert.match(blocked.error, /cifre/)
    assert.equal((await rows(db, 'select 1 from social_approvals')).length, 0)
    assert.equal((await approve(draft.id, true)).ok, true)
    await makeDue(draft.id)
    const first = await runFakeWorkerOnce(api, { scenario: 'ok', downloadMedia: true })
    assert.ok(first.some(step => step.action.startsWith('submitted') && step.status === 200))
    await db.query(`update social_delivery_jobs set next_check_at=now() where destination_id in
      (select d.id from social_destinations d join social_post_revisions r on r.id=d.revision_id where r.post_id=$1)`, [draft.id])
    await runFakeWorkerOnce(api, { scenario: 'ok' })
    const post = (await getPost(draft.id))!
    assert.equal(post.status, 'published')
    const url = post.destinations[0].job!.remote_url
    assert.ok(url)
    assert.ok(mediaDownloads > 0)
    assert.ok((await getOverview()).today.some(job => job.remote_url === url))
    assert.ok((await getCalendarWeek(resolveWeek(undefined))).days.some(day => day.entries.some(entry => entry.remote_url === url)))
  })

  it('partial generation checks each attached immutable card even if global spec has no figures', async () => {
    const second = await createManualAccount({ platform: 'substack', brandId: brand, displayName: 'Newsletter local' })
    assert.equal(second.ok, true)
    let draft = await createDraft([account, second.accountId])
    const firstCard = await generateCards({ postId: draft.id, baseRevisionId: draft.revision.id, spec, accountIds: [account] })
    assert.equal(firstCard.ok, true)
    draft = (await getDraft(draft.id))!
    assert.equal((await generateCards({ postId: draft.id, baseRevisionId: draft.revision.id, spec: { ...spec, stat: null }, accountIds: [second.accountId] })).ok, true)
    draft = await removeFigureList(draft.id)
    assert.equal(draft.revision.card_spec?.stat, null)
    assert.equal((await approve(draft.id, false)).ok, false)
  })

  it('manual handoff exposes signed card links and finishes with public URL', async () => {
    const account = await createManualAccount({ platform: 'substack', brandId: brand, displayName: 'Newsletter local' })
    assert.equal(account.ok, true)
    let draft = await createDraft([account.accountId])
    assert.equal((await generateCards({ postId: draft.id, baseRevisionId: draft.revision.id, spec: { ...spec, stat: null } })).ok, true)
    draft = (await getDraft(draft.id))!
    assert.equal((await approve(draft.id, false)).ok, true)
    await makeDue(draft.id)
    await runFakeWorkerOnce(api)
    const job = (await getPost(draft.id))!.destinations[0].job!
    const handoff = (await getManualJob(job.id))!
    assert.equal(handoff.handoff.body.plain.includes('Un ghid clar.'), true)
    assert.ok(handoff.media[0].url?.startsWith('/api/media/'))
    assert.equal((await fetch(new URL(handoff.media[0].url!, base))).status, 200)
    const url = 'https://example.test/newsletter/publicat'
    assert.equal((await markManualPublished(job.id, url)).ok, true)
    assert.equal((await getPost(draft.id))!.status, 'published')
    assert.ok((await getOverview()).today.some(job => job.remote_url === url))
  })

  it('production worker claims, verifies media and reports published in dry run without Postiz', async () => {
    const draft = await createDraft()
    assert.equal((await generateCards({ postId: draft.id, baseRevisionId: draft.revision.id, spec: { ...spec, stat: null } })).ok, true)
    assert.equal((await approve(draft.id, false)).ok, true)
    await makeDue(draft.id)
    const workerRoot = fileURLToPath(new URL('../../../../../worker/', import.meta.url))
    const script = `const {siteApi}=await import('./src/services/site-api.ts'); const {processJob}=await import('./src/loops/delivery.ts'); const {jobs}=await siteApi.claimDeliveries(); for(const job of jobs) await processJob(job); if(jobs.length!==1) throw new Error('Expected one claimed job');`
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: workerRoot,
      env: { ...process.env, SITE_BASE_URL: base, WORKER_TOKEN: token, WORKER_ID: 'integration-real', WORKER_DRY_RUN: 'true', POSTIZ_BASE_URL: `${base}/postiz`, POSTIZ_API_KEY: 'fake-postiz-key', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GENERATOR_PROVIDER: '' },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) }); child.stderr.on('data', chunk => { output += String(chunk) })
    const [code] = await once(child, 'exit')
    assert.equal(code, 0, output)
    assert.equal(postizCalls, 0)
    assert.ok(mediaDownloads > 0)
    const post = (await getPost(draft.id))!
    assert.equal(post.status, 'published')
    assert.match(post.destinations[0].job!.remote_url!, /dry-run/)
  })
})

it('approval hard-checks the actual painted card copy', () => {
  const row: ApprovalDestination = {
    id: crypto.randomUUID(), account_id: crypto.randomUUID(), platform: 'x', text: 'Un ghid clar.', settings: {}, scheduled_at: new Date(Date.now() + 3600_000).toISOString(), figures: [],
    account: { id: crypto.randomUUID(), display_name: 'Cont local', platform: 'x', mode: 'auto', status: 'connected', paused: false, daily_cap: 5, rules: {} },
    media: [{ media_id: crypto.randomUUID(), position: 0, alt_text: 'Card despre declaratie', sha256: 'ab'.repeat(32), mime: 'image/png', width: 1600, height: 900, card_spec: { ...spec, brand: 'taxes-support', headline: 'Profit sigur', keyword: 'sigur', stat: null } }],
  }
  const checked = checkDestinations([row], { kind: 'social', now: new Date() })[0]
  assert.equal(checked.validation.ok, false)
  assert.ok(checked.validation.errors.some(error => error.code === 'BANNED_PHRASE'))
})
