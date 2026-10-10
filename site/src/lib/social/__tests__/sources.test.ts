/**
 * Verified sources (amendment 07, migration 0012) on a real PGlite database:
 * the SQL functions, the "Verificat" action, the approval gate, the freeze
 * with the approval, duplicate, and the drafts route that stores them.
 * Never calls an AI or publishing API; the fake generator delivers the drafts.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { MIGRATIONS_DIR, migratedDb, migrationFiles } from '../../testing/pglite-db.ts'
import { createFakeSupabase } from '../../testing/fake-supabase.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { setTestAdmin } from '../../testing/auth-shim.ts'
import { routeFetch } from '../../testing/route-fetch.ts'
import { adminUser, brandId, createAccount, resetSocial, rows, scheduleAndApprove } from '../../testing/social-fixtures.ts'
import { WorkerApi } from '../fake/worker-api-client.ts'
import { runFakeGeneratorOnce } from '../fake/fake-generator.ts'
import { approvePost, reopenForEdit } from '../approval-actions.ts'
import { getPost } from '../approval-queries.ts'
import { duplicatePost } from '../handoff-actions.ts'
import { setSourceVerified } from '../sources-actions.ts'
import { getPostSources } from '../sources-queries.ts'
import { toLocalInputs } from '../time.ts'

const TOKEN = 'sources-test-token-0123456789abcdef0123'
let db: PGlite
let brand: string
let admin: { userId: string; email: string }
let api: WorkerApi

const tomorrow = () => toLocalInputs(new Date(Date.now() + 24 * 3600_000))
const SRC = (n: number) => ({
  url: `https://example.com/sursa-${n}`,
  title: `Sursa ${n}`,
  publisher: 'Example News',
  published_at: '1 mai 2026',
  note: `Sustine ideea ${n}.`,
  found_in_search: true,
})

async function draft(accounts: string[], text = 'Un ghid clar pentru documentele tale.') {
  const [p] = await rows(db, 'select social_create_post($1::jsonb, $2::jsonb, $3::jsonb) as id', [
    JSON.stringify({ brand_id: brand, kind: 'social', title: 'Ghid', created_by: admin.userId }),
    JSON.stringify({ canonical_text: text }),
    JSON.stringify(accounts.map((account_id) => ({ account_id, text, settings: {} }))),
  ])
  return p.id as string
}

async function addSources(post: string, list: unknown[]): Promise<number> {
  return (await rows(db, 'select social_add_post_sources($1, $2::jsonb) as n', [post, JSON.stringify(list)]))[0].n
}

/** Approve the post's latest revision at tomorrow's time (a new revision is saved first when the time differs). */
async function approveLatest(postId: string) {
  const post = (await getPost(postId))!
  return approvePost({
    postId,
    revisionId: post.revision.id,
    times: Object.fromEntries(post.destinations.map((d) => [d.account_id, tomorrow()])),
    figuresChecked: false,
  })
}

describe('verified sources (amendment 07)', () => {
  before(async () => {
    db = await migratedDb()
    setTestAdminClient(createFakeSupabase(db))
    brand = await brandId(db)
    admin = { userId: await adminUser(db), email: 'admin@example.test' }
    api = new WorkerApi({ baseUrl: 'http://127.0.0.1:3000', token: TOKEN, workerId: 'sources-worker', fetch: routeFetch })
  })
  after(async () => {
    setTestAdminClient(null)
    setTestAdmin(null)
    await db.close()
  })
  beforeEach(async () => {
    // resetSocial deletes posts with triggers off, so the sources go first.
    await db.exec(`
      set session_replication_role = replica;
      delete from social_post_sources; delete from social_automation_runs;
      set session_replication_role = origin;`)
    await resetSocial(db)
    setTestAdmin(admin)
    process.env.WORKER_TOKEN = TOKEN
    process.env.SOCIAL_PUBLISHING_ENABLED = 'true'
  })

  describe('social_add_post_sources', () => {
    it('is idempotent on (post, url), skips entries without an http(s) URL, and adds them unverified', async () => {
      const post = await draft([await createAccount(db, brand, 'x')])
      const first = await addSources(post, [
        SRC(1),
        SRC(2),
        { ...SRC(2), title: 'dublura in acelasi apel' },
        { url: 'javascript:alert(1)', title: 'rea' },
        { title: 'fara url' },
        'nu e obiect',
      ])
      assert.equal(first, 2)
      assert.equal(await addSources(post, [SRC(1), SRC(2)]), 0, 're-delivery adds nothing')
      assert.equal(await addSources(post, [SRC(2), SRC(3)]), 1, 'only the new url is added')

      const list = await getPostSources(post)
      assert.deepEqual(list.map((s) => s.url), [SRC(1).url, SRC(2).url, SRC(3).url])
      assert.equal(list[1].title, 'Sursa 2', 'the first delivery of a url wins')
      assert.deepEqual(
        { publisher: list[0].publisher, published_at: list[0].published_at, note: list[0].note, found_in_search: list[0].found_in_search },
        { publisher: 'Example News', published_at: '1 mai 2026', note: 'Sustine ideea 1.', found_in_search: true }
      )
      assert.ok(list.every((s) => s.verified_at === null && s.verified_by === null))

      const logged = await rows(db, `select details, actor_email from social_activity_log where action = 'social.sources_added' order by id`)
      assert.deepEqual(logged.map((l) => l.details.count), [2, 1], 'one activity row per call that added something')
      assert.equal(logged[0].actor_email, 'system')
    })

    it('refuses an unknown post and a payload that is not an array', async () => {
      await assert.rejects(addSources('00000000-0000-4000-8000-000000000000', [SRC(1)]), /SOCIAL_POST_NOT_FOUND/)
      const post = await draft([await createAccount(db, brand, 'x')])
      await assert.rejects(rows(db, `select social_add_post_sources($1, '{"url":"https://example.com"}'::jsonb)`, [post]), /SOCIAL_BAD_SOURCES/)
      assert.equal(await addSources(post, []), 0)
    })

    it('keeps lengths inside the table limits', async () => {
      const post = await draft([await createAccount(db, brand, 'x')])
      await addSources(post, [{ ...SRC(1), title: 'T'.repeat(500), note: 'N'.repeat(900), publisher: 'P'.repeat(400), published_at: 'D'.repeat(90) }])
      const [s] = await getPostSources(post)
      assert.deepEqual([s.title.length, s.note?.length, s.publisher?.length, s.published_at?.length], [300, 500, 200, 40])
    })

    it('goes with its post (cascade)', async () => {
      const post = await draft([await createAccount(db, brand, 'x')])
      await addSources(post, [SRC(1), SRC(2)])
      await rows(db, `delete from social_posts where id = $1`, [post])
      assert.equal((await rows(db, `select count(*)::int n from social_post_sources`))[0].n, 0)
    })
  })

  describe('setSourceVerified', () => {
    it('ticks and unticks, one activity row per real change, and is idempotent', async () => {
      const post = await draft([await createAccount(db, brand, 'x')])
      await addSources(post, [SRC(1), SRC(2)])
      const [a, b] = await getPostSources(post)

      assert.deepEqual(await setSourceVerified(a.id, true), { ok: true })
      const [ticked] = await rows(db, `select verified_at, verified_by from social_post_sources where id = $1`, [a.id])
      assert.ok(ticked.verified_at)
      assert.equal(ticked.verified_by, admin.userId)
      assert.equal((await getPostSources(post)).find((s) => s.id === b.id)?.verified_at, null, 'the other source is untouched')

      assert.deepEqual(await setSourceVerified(a.id, true), { ok: true }, 'the same tick again')
      const afterTick = await rows(db, `select actor_id, actor_email, action, post_id, details from social_activity_log where action in ('social.source_verified', 'social.source_unverified') order by id`)
      assert.equal(afterTick.length, 1, 'no second row for a no-op')
      assert.deepEqual(
        { actor_id: afterTick[0].actor_id, actor_email: afterTick[0].actor_email, action: afterTick[0].action, post_id: afterTick[0].post_id },
        { actor_id: admin.userId, actor_email: admin.email, action: 'social.source_verified', post_id: post }
      )
      assert.deepEqual(afterTick[0].details, { source_id: a.id, url: SRC(1).url })

      assert.deepEqual(await setSourceVerified(a.id, false), { ok: true })
      const [unticked] = await rows(db, `select verified_at, verified_by from social_post_sources where id = $1`, [a.id])
      assert.deepEqual(unticked, { verified_at: null, verified_by: null })
      const actions = (await rows(db, `select action from social_activity_log where action in ('social.source_verified', 'social.source_unverified') order by id`)).map((r) => r.action)
      assert.deepEqual(actions, ['social.source_verified', 'social.source_unverified'])
    })

    it('needs an admin, a real source id and a boolean; writes nothing otherwise', async () => {
      const post = await draft([await createAccount(db, brand, 'x')])
      await addSources(post, [SRC(1)])
      const [s] = await getPostSources(post)

      setTestAdmin(null)
      assert.equal((await setSourceVerified(s.id, true)).ok, false)
      setTestAdmin(admin)
      assert.equal((await setSourceVerified('not-a-uuid', true)).ok, false)
      assert.equal((await setSourceVerified('00000000-0000-4000-8000-000000000000', true)).ok, false)
      assert.equal((await setSourceVerified(s.id, 'yes' as unknown as boolean)).ok, false)
      const gone = await setSourceVerified('00000000-0000-4000-8000-000000000000', true)
      assert.equal(gone.ok === false && /nu mai exista/.test(gone.error), true)

      assert.equal((await getPostSources(post))[0].verified_at, null)
      assert.equal((await rows(db, `select count(*)::int n from social_activity_log where action like 'social.source\\_%'`))[0].n, 0)
    })
  })

  describe('approval and the freeze', () => {
    it('refuses approval while a source is unverified, allows it once all are ticked', async () => {
      const post = await draft([await createAccount(db, brand, 'x')])
      await addSources(post, [SRC(1), SRC(2)])
      const [a, b] = await getPostSources(post)

      const blocked = await approveLatest(post)
      assert.equal(blocked.ok, false)
      if (!blocked.ok) assert.match(blocked.error, /Verifica toate sursele/)
      assert.equal((await rows(db, `select count(*)::int n from social_approvals`))[0].n, 0)

      await setSourceVerified(a.id, true)
      const still = await approveLatest(post)
      assert.equal(still.ok, false, 'one tick of two is not enough')

      await setSourceVerified(b.id, true)
      const done = await approveLatest(post)
      assert.equal(done.ok, true, JSON.stringify(done))
      assert.equal((await rows(db, `select count(*)::int n from social_approvals where revoked_at is null`))[0].n, 1)
      assert.equal((await rows(db, `select count(*)::int n from social_delivery_jobs`))[0].n, 1)
    })

    it('does not touch posts without sources', async () => {
      const post = await draft([await createAccount(db, brand, 'x')])
      const done = await approveLatest(post)
      assert.equal(done.ok, true, JSON.stringify(done))
    })

    it('the database itself refuses (SOCIAL_SOURCES_NOT_VERIFIED), whatever the server checked', async () => {
      const post = await draft([await createAccount(db, brand, 'x')])
      await addSources(post, [SRC(1)])
      // The fixture saves a scheduled revision and approves it with real hashes, straight through the SQL function.
      await assert.rejects(scheduleAndApprove(db, post, admin.userId), /SOCIAL_SOURCES_NOT_VERIFIED/)
      assert.equal((await rows(db, `select count(*)::int n from social_approvals`))[0].n, 0)
      await rows(db, `update social_post_sources set verified_at = now(), verified_by = $1 where post_id = $2`, [admin.userId, post])
      const approved = await scheduleAndApprove(db, post, admin.userId)
      assert.equal(approved.jobs.length, 1)
    })

    it('freezes the ticks with the approval, and an edit thaws them', async () => {
      const post = await draft([await createAccount(db, brand, 'x')])
      await addSources(post, [SRC(1), SRC(2)])
      for (const s of await getPostSources(post)) assert.equal((await setSourceVerified(s.id, true)).ok, true)
      assert.equal((await approveLatest(post)).ok, true)
      const [first] = await getPostSources(post)

      const refused = await setSourceVerified(first.id, false)
      assert.equal(refused.ok, false)
      if (!refused.ok) assert.match(refused.error, /aprobata/)
      await assert.rejects(rows(db, `select social_set_source_verified($1, $2, false)`, [first.id, admin.userId]), /SOCIAL_SOURCES_FROZEN/)
      await assert.rejects(rows(db, `select social_set_source_verified($1, $2, true)`, [first.id, admin.userId]), /SOCIAL_SOURCES_FROZEN/, 'even to the state it is already in')
      assert.equal(await addSources(post, [SRC(9)]), 0, 'nothing is added to an approved post')
      assert.equal((await getPostSources(post)).length, 2)
      assert.ok((await getPostSources(post)).every((s) => s.verified_at))

      // An edit is a new revision; the approval is revoked and the sources are free again.
      const current = (await getPost(post))!
      const reopened = await reopenForEdit({ postId: post, revisionId: current.revision.id })
      assert.equal(reopened.ok && reopened.reopened, true, JSON.stringify(reopened))
      assert.equal((await rows(db, `select count(*)::int n from social_approvals where revoked_at is null`))[0].n, 0)
      assert.deepEqual(await setSourceVerified(first.id, false), { ok: true })
      const again = await approveLatest(post)
      assert.equal(again.ok, false, 'a source is unticked again, so approval waits')
      assert.deepEqual(await setSourceVerified(first.id, true), { ok: true })
      assert.equal((await approveLatest(post)).ok, true)
    })
  })

  describe('duplicatePost', () => {
    it('copies the sources with the same order and notes, every one unverified again', async () => {
      const x = await createAccount(db, brand, 'x')
      const post = await draft([x])
      await addSources(post, [SRC(1), SRC(2), SRC(3)])
      for (const s of await getPostSources(post)) await setSourceVerified(s.id, true)

      const copied = await duplicatePost(post)
      assert.equal(copied.ok, true, JSON.stringify(copied))
      if (!copied.ok) return
      const original = await getPostSources(post)
      const copy = await getPostSources(copied.postId)
      assert.deepEqual(
        copy.map(({ url, title, publisher, published_at, note, found_in_search }) => ({ url, title, publisher, published_at, note, found_in_search })),
        original.map(({ url, title, publisher, published_at, note, found_in_search }) => ({ url, title, publisher, published_at, note, found_in_search }))
      )
      assert.ok(copy.every((s) => s.verified_at === null && s.verified_by === null), 'verification is reset')
      assert.ok(copy.every((s, i) => s.id !== original[i].id), 'new rows')
      assert.ok(original.every((s) => s.verified_at), 'the original keeps its ticks')

      const [log] = await rows(db, `select details from social_activity_log where action = 'social.post_duplicated'`)
      assert.equal(log.details.sources_copied, 3)

      const blocked = await approveLatest(copied.postId)
      assert.equal(blocked.ok, false, 'the copy waits for its own ticks')
    })

    it('copies nothing for a post without sources', async () => {
      const post = await draft([await createAccount(db, brand, 'x')])
      const copied = await duplicatePost(post)
      assert.equal(copied.ok, true)
      if (copied.ok) assert.deepEqual(await getPostSources(copied.postId), [])
    })
  })

  describe('the drafts route', () => {
    async function request(input: Record<string, unknown>): Promise<string> {
      const [r] = await rows(db, `insert into social_generation_requests (brand_id, input, requested_by) values ($1, $2::jsonb, $3) returning id`, [
        brand,
        JSON.stringify({ platforms: ['x', 'linkedin-page'], kinds: ['social'], count: 2, language: 'ro', templates: ['dark'], ...input }),
        admin.userId,
      ])
      return r.id as string
    }

    it('stores each draft\'s sources and the figure source_url when the request asks for research', async () => {
      await createAccount(db, brand, 'x')
      await createAccount(db, brand, 'linkedin-page')
      await request({ source: { type: 'topic', topic: 'Declaratia Unica', hooks: [] }, research: true })

      const [done] = await runFakeGeneratorOnce(api)
      assert.equal(done.status, 200, JSON.stringify(done.body))
      assert.deepEqual(done.body, { created: 2, skipped: 0 })

      const posts = await rows(db, `select id, current_revision_id from social_posts order by created_at, id`)
      assert.equal(posts.length, 2)
      for (const p of posts) {
        const sources = await getPostSources(p.id)
        assert.equal(sources.length, 3)
        assert.ok(sources.every((s) => s.url.startsWith('https://example.com/') && s.verified_at === null && s.found_in_search))
        const [rev] = await rows(db, `select figures from social_post_revisions where id = $1`, [p.current_revision_id])
        const web = rev.figures.find((f: { source_url?: string }) => f.source_url)
        assert.deepEqual(web, {
          value: '16%',
          context: 'cota de impozit citata dintr-un articol recent',
          source: 'unverified',
          source_url: 'https://example.com/stiri/impozit-crypto-explicat',
        })
        const destFigures = await rows(db, `select figures from social_destinations where revision_id = $1`, [p.current_revision_id])
        assert.ok(destFigures.every((d) => d.figures.some((f: { source_url?: string }) => f.source_url)))
        // The unverified web figure blocks approval on its own (the figures gate); the sources gate is separate.
        assert.ok(destFigures.every((d) => d.figures.some((f: { source: string }) => f.source === 'unverified')))
      }
    })

    it('a news source also researches; a plain request stores no sources and no source_url', async () => {
      await createAccount(db, brand, 'x')
      await request({ source: { type: 'news', topic: '', window_days: 7 }, platforms: ['x'], count: 1 })
      const [news] = await runFakeGeneratorOnce(api)
      assert.equal(news.status, 200)
      const [newsPost] = await rows(db, `select id from social_posts`)
      assert.equal((await getPostSources(newsPost.id)).length, 3)

      await resetPostsOnly()
      await request({ source: { type: 'topic', topic: 'Declaratia Unica', hooks: [] }, platforms: ['x'], count: 1 })
      const [plain] = await runFakeGeneratorOnce(api)
      assert.equal(plain.status, 200)
      const [post] = await rows(db, `select id, current_revision_id from social_posts`)
      assert.deepEqual(await getPostSources(post.id), [])
      const [rev] = await rows(db, `select figures from social_post_revisions where id = $1`, [post.current_revision_id])
      assert.ok(rev.figures.every((f: { source_url?: string | null }) => !f.source_url))
    })

    async function resetPostsOnly() {
      await db.exec(`set session_replication_role = replica; delete from social_post_sources; set session_replication_role = origin;`)
      await resetSocial(db)
      await createAccount(db, brand, 'x')
    }

    const crafted = () => ({
      client_ref: 'a',
      kind: 'social',
      title: null,
      canonical_text: 'Cota de impozit este 16% din castig.',
      source_url: null,
      variants: [{ platform: 'x', text: 'Cota de impozit este 16% din castig.', settings: {} }],
      article: null,
      card: null,
      figures: [
        { value: '16%', context: 'cota', source: 'unverified', source_url: 'https://example.com/cota' },
        { value: '10%', context: 'altceva', source: 'facts', source_url: 'javascript:alert(1)' },
      ],
      sources: [
        { url: 'https://example.com/cota', title: 'Cota', publisher: 'Example', published_at: '2 mai 2026', note: 'Cota de 16%.', found_in_search: true },
        { url: '  https://example.com/cota  ', title: 'Aceeasi pagina, alt titlu', found_in_search: true },
        { url: 'javascript:alert(1)', title: 'Rea' },
        { url: 'ftp://example.com/fisier', title: 'Nu e http' },
        { url: 'https://example.com/legea', title: 'Legea', found_in_search: false },
      ],
      validation_errors: [],
      notes: null,
    })

    it('drops bad links, keeps the rest, and a re-delivery adds nothing (and heals a stopped delivery)', async () => {
      await createAccount(db, brand, 'x')
      const id = await request({ source: { type: 'topic', topic: 'Cota de impozit', hooks: [] }, platforms: ['x'], count: 1 })
      const claim = await api.post<{ requests: Array<{ request_id: string }> }>('/generation/claim', { limit: 1 })
      assert.equal(claim.body.requests[0].request_id, id)

      const first = await api.post(`/generation/${id}/drafts`, { drafts: [crafted()] })
      assert.deepEqual(first.body, { created: 1, skipped: 0 })
      const [post] = await rows(db, `select id, current_revision_id from social_posts`)
      const sources = await getPostSources(post.id)
      assert.deepEqual(sources.map((s) => [s.url, s.found_in_search]), [
        ['https://example.com/cota', true],
        ['https://example.com/legea', false],
      ])
      assert.equal(sources[0].title, 'Cota', 'the first of two equal urls wins')
      const [rev] = await rows(db, `select figures from social_post_revisions where id = $1`, [post.current_revision_id])
      assert.deepEqual(rev.figures, [
        { value: '16%', context: 'cota', source: 'unverified', source_url: 'https://example.com/cota' },
        { value: '10%', context: 'altceva', source: 'facts', source_url: null },
      ])

      const again = await api.post(`/generation/${id}/drafts`, { drafts: [crafted()] })
      assert.deepEqual(again.body, { created: 0, skipped: 1 })
      assert.equal((await getPostSources(post.id)).length, 2)
      assert.equal((await rows(db, `select count(*)::int n from social_activity_log where action = 'social.sources_added'`))[0].n, 1)

      // A delivery that stopped between the post and its sources: the same drafts again complete it.
      await db.exec(`set session_replication_role = replica; delete from social_post_sources; set session_replication_role = origin;`)
      const healed = await api.post(`/generation/${id}/drafts`, { drafts: [crafted()] })
      assert.deepEqual(healed.body, { created: 0, skipped: 1 })
      assert.equal((await getPostSources(post.id)).length, 2)
    })

    it('a draft without a sources key still works (older worker)', async () => {
      await createAccount(db, brand, 'x')
      const id = await request({ source: { type: 'topic', topic: 'Cota de impozit', hooks: [] }, platforms: ['x'], count: 1 })
      await api.post('/generation/claim', { limit: 1 })
      const { sources: _drop, ...old } = crafted()
      void _drop
      const r = await api.post(`/generation/${id}/drafts`, { drafts: [old] })
      assert.deepEqual(r.body, { created: 1, skipped: 0 })
      const [post] = await rows(db, `select id from social_posts`)
      assert.deepEqual(await getPostSources(post.id), [])
    })
  })

  describe('the schema', () => {
    it('closes both new tables to the browser roles (RLS on, no policies, no rights)', async () => {
      for (const table of ['social_post_sources', 'social_automation_runs']) {
        const [t] = await rows(
          db,
          `select c.relrowsecurity as rls,
                  has_table_privilege('anon', c.oid, 'select') as anon_select,
                  has_table_privilege('authenticated', c.oid, 'insert') as auth_insert,
                  has_table_privilege('service_role', c.oid, 'select') as service_select,
                  (select count(*)::int from pg_policies p where p.tablename = $1) as policies
             from pg_class c where c.oid = ('public.' || $1)::regclass`,
          [table]
        )
        assert.deepEqual(t, { rls: true, anon_select: false, auth_insert: false, service_select: true, policies: 0 }, table)
      }
    })

    it('0012 applies over a database that already holds data, and applies again without harm', async () => {
      const stubs = readFileSync(join(import.meta.dirname, '..', '..', 'testing', 'supabase-stubs.sql'), 'utf8')
      const files = migrationFiles()
      const last = files.find((f) => f.startsWith('0012'))!
      const old = await PGlite.create()
      try {
        await old.exec(stubs)
        for (const f of files.filter((name) => name < last)) await old.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
        await old.exec(`
          insert into social_posts (brand_id, kind, title, status)
            select id, 'social', 'Postare veche', 'draft' from social_brands where slug = 'taxes-support';
          insert into social_automation_runs (workflow, event_id, status) values ('legacy', 'e1', 'ok'), ('legacy', 'e2', 'running');`)
        await old.exec(readFileSync(join(MIGRATIONS_DIR, last), 'utf8'))
        await old.exec(readFileSync(join(MIGRATIONS_DIR, last), 'utf8'))

        const runs = (await old.query<{ event_id: string; created_at: string; updated_at: string }>(`select event_id, created_at::text, updated_at::text from social_automation_runs order by event_id`)).rows
        assert.equal(runs.length, 2)
        assert.ok(runs.every((r) => r.updated_at === r.created_at), 'existing rows get updated_at = created_at')
        const constraint = await old.query(`select 1 from pg_constraint where conname = 'social_automation_runs_status_check'`)
        assert.equal(constraint.rows.length, 0, 'a status outside ok / error / skipped keeps the constraint off instead of failing')
        const [{ id: post }] = (await old.query<{ id: string }>(`select id from social_posts`)).rows
        assert.equal((await old.query<{ n: number }>(`select social_add_post_sources($1, '[{"url":"https://example.com/a"}]'::jsonb) as n`, [post])).rows[0].n, 1)
      } finally {
        await old.close()
      }
    })
  })
})
