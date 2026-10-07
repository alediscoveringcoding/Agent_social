/**
 * Amendment 05: nine manual-only channels. Quora, LinkedIn (articol),
 * TradingView, Investing.com, Indie Hackers, Stack Exchange, GitHub, Forum and
 * Presa have no API this app uses, so every account is manual.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PGlite } from '@electric-sql/pglite'
import { migratedDb } from '../../testing/pglite-db.ts'
import { createFakeSupabase } from '../../testing/fake-supabase.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { setTestAdmin } from '../../testing/auth-shim.ts'
import { routeFetch } from '../../testing/route-fetch.ts'
import { adminUser, brandId, resetSocial, rows } from '../../testing/social-fixtures.ts'
import {
  CARD_FORMATS,
  DEFAULT_OPEN_EDITOR_URLS,
  MANUAL_ONLY_PLATFORMS,
  MANUAL_ONLY_REASONS,
  PLATFORMS,
  PLATFORM_CARD_FORMAT,
  PLATFORM_KIND,
  PLATFORM_LABELS,
  REDDIT_SUBREDDIT_SUGGESTIONS,
  type Platform,
} from '../constants.ts'
import { findDiacritics } from '../content-rules.ts'
import { sanitizeSettings } from '../draft-edit.ts'
import { mapDraft } from '../draft-mapping.ts'
import { buildHandoff } from '../handoff.ts'
import { SETTINGS_FIELDS, settingsFieldKeys } from '../platform-settings.ts'
import { DraftSchema } from '../schemas.ts'
import { platformForProvider } from '../sync-rules.ts'
import { validateDestination, type ValidateDestinationInput } from '../validation.ts'
import { DRAFT_FIXTURES } from '../fake/fixtures.ts'
import { WorkerApi } from '../fake/worker-api-client.ts'
import { FAKE_INTEGRATIONS, runFakeWorkerOnce, syncFakeAccounts } from '../fake/fake-worker.ts'
import { approvePost } from '../approval-actions.ts'
import { getPost } from '../approval-queries.ts'
import { createManualAccount, updateAccount } from '../accounts-actions.ts'
import { markManualPublished } from '../handoff-actions.ts'
import { getManualJob } from '../handoff-queries.ts'
import { toLocalInputs } from '../time.ts'

const BATCH3 = ['quora', 'linkedin-article', 'tradingview', 'investing', 'indiehackers', 'stackexchange', 'github', 'forum', 'press'] as const satisfies readonly Platform[]
const ARTICLES: readonly Platform[] = ['linkedin-article', 'github', 'press']
const NOW = new Date('2026-11-01T08:00:00Z')
const LATER = '2026-11-02T08:00:00Z'
const TEXT = 'Afla ce trebuie sa stii despre declaratie, pas cu pas.'
const OURS = 'https://thecrypto.support/ghid/impozit-crypto'

function check(platform: Platform, over: Partial<ValidateDestinationInput> = {}) {
  return validateDestination({ platform, text: TEXT, settings: {}, media: [], figures: [], scheduledAt: LATER, now: NOW, ...over })
}
const codes = (v: ReturnType<typeof check>) => v.errors.map((e) => e.code).sort()
const warns = (v: ReturnType<typeof check>) => v.warnings.map((e) => e.code).sort()
const a = (n: number) => 'a'.repeat(n)
const image = (altText = 'Card despre declaratie') => ({ mediaId: 'm1', mime: 'image/png', width: 1600, height: 840, altText })

describe('manual channels (amendment 05): tables', () => {
  it('nine new platforms, all manual-only, with labels, kinds, card formats and editor links', () => {
    assert.equal(PLATFORMS.length, 44)
    for (const p of BATCH3) {
      assert.ok((PLATFORMS as readonly string[]).includes(p), p)
      assert.ok(MANUAL_ONLY_PLATFORMS.includes(p), `${p} is manual-only`)
      assert.ok(MANUAL_ONLY_REASONS[p], `${p} has a reason`)
      assert.deepEqual(findDiacritics(PLATFORM_LABELS[p]), [], p)
      assert.deepEqual(findDiacritics(MANUAL_ONLY_REASONS[p] ?? ''), [], p)
      assert.equal(PLATFORM_KIND[p], ARTICLES.includes(p) ? 'article' : 'social', p)
      assert.ok(PLATFORM_CARD_FORMAT[p] in CARD_FORMATS, p)
      assert.ok(p in SETTINGS_FIELDS || p === 'quora', `${p} has editor fields`)
      if (p !== 'forum' && p !== 'press') assert.match(DEFAULT_OPEN_EDITOR_URLS[p] ?? '', /^https:\/\//, p)
    }
    assert.equal(DEFAULT_OPEN_EDITOR_URLS.forum, undefined)
    assert.equal(DEFAULT_OPEN_EDITOR_URLS.press, undefined)
    assert.equal(MANUAL_ONLY_PLATFORMS.length, 12)
    assert.equal(PLATFORM_LABELS['linkedin-article'], 'LinkedIn (articol)')
    assert.equal(PLATFORM_LABELS.press, 'Presa (comunicat)')
    assert.equal(new Set(PLATFORMS.map((p) => PLATFORM_LABELS[p])).size, PLATFORMS.length, 'labels are unique')
    // No Postiz provider: the sync ignores these names.
    for (const p of BATCH3) assert.equal(platformForProvider(p), null, p)
  })

  it('every settings key of the editor tables is kept by the sanitizer', () => {
    for (const p of BATCH3) {
      const keys = settingsFieldKeys(p)
      const out = sanitizeSettings(p, Object.fromEntries(keys.map((k) => [k, k === 'tags' ? 'a, b' : 'x'])))
      assert.deepEqual(Object.keys(out).sort(), [...keys].sort(), p)
    }
  })

  it('Reddit suggests the six communities, without forcing them', () => {
    assert.deepEqual([...REDDIT_SUBREDDIT_SUGGESTIONS], ['r/Romania', 'r/RoInvestitii', 'r/eupersonalfinance', 'r/Trading212', 'r/interactivebrokers', 'r/eToro'])
    assert.deepEqual(SETTINGS_FIELDS.reddit?.find((f) => f.key === 'subreddit')?.suggestions, REDDIT_SUBREDDIT_SUGGESTIONS)
    assert.equal(check('reddit', { settings: { subreddit: 'r/altceva', title: 'T' } }).ok, true)
  })
})

describe('manual channels (amendment 05): validation', () => {
  it('Quora: the question or Space link is required', () => {
    assert.equal(check('quora', { settings: { target_url: 'https://www.quora.com/Intrebare' } }).ok, true)
    assert.deepEqual(codes(check('quora')), ['QUORA_TARGET_MISSING'])
    assert.deepEqual(codes(check('quora', { settings: { target_url: 'quora' } })), ['QUORA_TARGET_INVALID'])
    assert.deepEqual(codes(check('quora', { text: a(20001), settings: { target_url: OURS } })), ['TOO_LONG'])
  })

  it('LinkedIn (articol): an article with a title of at most 100 characters and one cover', () => {
    assert.equal(check('linkedin-article', { settings: { title: 'Un titlu' } }).ok, true)
    assert.deepEqual(codes(check('linkedin-article')), ['TITLE_MISSING'])
    assert.equal(check('linkedin-article', { settings: { title: a(100) } }).ok, true)
    assert.deepEqual(codes(check('linkedin-article', { settings: { title: a(101) } })), ['LINKEDIN_ARTICLE_TITLE_TOO_LONG'])
    assert.deepEqual(codes(check('linkedin-article', { settings: { title: 'T' }, media: [image(), image()] })), ['TOO_MANY_IMAGES'])
    assert.deepEqual(codes(check('linkedin-article', { text: a(110001), settings: { title: 'T' } })), ['TOO_LONG'])
  })

  it('TradingView: symbol and title required', () => {
    const ok = { symbol: 'BINANCE:BTCUSDT', title: 'BTC, o privire calma' }
    assert.equal(check('tradingview', { settings: ok }).ok, true)
    assert.deepEqual(codes(check('tradingview')), ['TRADINGVIEW_SYMBOL_MISSING', 'TRADINGVIEW_TITLE_MISSING'])
    assert.deepEqual(codes(check('tradingview', { settings: { ...ok, symbol: 'BTC USDT' } })), ['TRADINGVIEW_SYMBOL_INVALID'])
    assert.deepEqual(codes(check('tradingview', { settings: { ...ok, title: a(101) } })), ['TRADINGVIEW_TITLE_TOO_LONG'])
  })

  it('Investing.com: the instrument page is required', () => {
    assert.equal(check('investing', { settings: { instrument_url: 'https://www.investing.com/crypto/bitcoin' } }).ok, true)
    assert.deepEqual(codes(check('investing')), ['INVESTING_INSTRUMENT_MISSING'])
    assert.deepEqual(codes(check('investing', { settings: { instrument_url: 'bitcoin' } })), ['INVESTING_INSTRUMENT_INVALID'])
  })

  it('Indie Hackers: a title, an optional group', () => {
    assert.equal(check('indiehackers', { settings: { title: 'Un titlu', group: 'Sasha' } }).ok, true)
    assert.deepEqual(codes(check('indiehackers')), ['INDIEHACKERS_TITLE_MISSING'])
    assert.deepEqual(codes(check('indiehackers', { settings: { title: a(151) } })), ['INDIEHACKERS_TITLE_TOO_LONG'])
  })

  it('Stack Exchange: an answer needs the question; a question needs a 15-150 title and 1-5 tags; the body is 30-30,000', () => {
    const answer = { question_url: 'https://money.stackexchange.com/questions/1/x' }
    const disclosed = 'Sunt afiliat cu Taxes Support si am scris un ghid despre impozitul pe crypto.'
    assert.equal(check('stackexchange', { text: disclosed, settings: answer }).ok, true)
    assert.deepEqual(warns(check('stackexchange', { text: disclosed, settings: answer })), [])
    assert.deepEqual(warns(check('stackexchange', { settings: answer })), ['SE_AFFILIATION'], 'no disclosure: a warning')
    assert.deepEqual(codes(check('stackexchange', { text: disclosed })), ['SE_QUESTION_MISSING'])
    assert.deepEqual(codes(check('stackexchange', { text: disclosed, settings: { question_url: 'x' } })), ['SE_QUESTION_INVALID'])
    assert.deepEqual(codes(check('stackexchange', { text: 'Prea scurt', settings: answer })), ['SE_BODY_TOO_SHORT'])
    assert.equal(check('stackexchange', { text: a(30000), settings: answer }).ok, true)
    assert.deepEqual(codes(check('stackexchange', { text: a(30001), settings: answer })), ['TOO_LONG'])
    assert.deepEqual(codes(check('stackexchange', { text: disclosed, settings: { ...answer, site: 'nu e site' } })), ['SE_SITE_INVALID'])
    assert.deepEqual(codes(check('stackexchange', { text: disclosed, settings: { ...answer, post_type: 'comment' } })), ['SE_TYPE_INVALID'])

    const question = { post_type: 'question', title: 'Cum declar castigurile din crypto?', tags: ['taxes', 'crypto'] }
    assert.equal(check('stackexchange', { text: disclosed, settings: question }).ok, true)
    assert.deepEqual(codes(check('stackexchange', { text: disclosed, settings: { post_type: 'question' } })), ['SE_TAGS_MISSING', 'SE_TITLE_MISSING'])
    assert.deepEqual(codes(check('stackexchange', { text: disclosed, settings: { ...question, title: a(14) } })), ['SE_TITLE_LENGTH'])
    assert.equal(check('stackexchange', { text: disclosed, settings: { ...question, title: a(150) } }).ok, true)
    assert.deepEqual(codes(check('stackexchange', { text: disclosed, settings: { ...question, title: a(151) } })), ['SE_TITLE_LENGTH'])
    assert.equal(check('stackexchange', { text: disclosed, settings: { ...question, tags: ['a', 'b', 'c', 'd', 'e'] } }).ok, true)
    assert.deepEqual(codes(check('stackexchange', { text: disclosed, settings: { ...question, tags: ['a', 'b', 'c', 'd', 'e', 'f'] } })), ['TOO_MANY_TAGS'])
    assert.deepEqual(codes(check('stackexchange', { text: disclosed, settings: { ...question, tags: [a(36)] } })), ['TAG_TOO_LONG'])
  })

  it('GitHub: repo required; a release needs a tag, a discussion a category; 125,000 characters', () => {
    const release = { repo: 'org/proiect', title: 'v1.2.0', tag: 'v1.2.0' }
    assert.equal(check('github', { settings: release }).ok, true)
    assert.deepEqual(codes(check('github')), ['GITHUB_REPO_MISSING', 'GITHUB_TAG_MISSING', 'TITLE_MISSING'])
    assert.deepEqual(codes(check('github', { settings: { ...release, repo: 'proiect' } })), ['GITHUB_REPO_INVALID'])
    assert.deepEqual(codes(check('github', { settings: { ...release, tag: 'v 1' } })), ['GITHUB_TAG_INVALID'])
    const discussion = { repo: 'org/proiect', title: 'Anunt', post_type: 'discussion' }
    assert.deepEqual(codes(check('github', { settings: discussion })), ['GITHUB_CATEGORY_MISSING'])
    assert.equal(check('github', { settings: { ...discussion, category: 'Announcements' } }).ok, true)
    assert.deepEqual(codes(check('github', { settings: { ...release, post_type: 'issue' } })), ['GITHUB_TYPE_INVALID'])
    assert.equal(check('github', { text: a(125000), settings: release }).ok, true)
    assert.deepEqual(codes(check('github', { text: a(125001), settings: release })), ['TOO_LONG'])
  })

  it('Forum: exactly one of the thread link and the title', () => {
    assert.equal(check('forum', { settings: { thread_url: 'https://forum.example.test/t/1' } }).ok, true)
    assert.equal(check('forum', { settings: { title: 'Un fir nou' } }).ok, true)
    assert.deepEqual(codes(check('forum')), ['FORUM_TARGET_MISSING'])
    assert.deepEqual(codes(check('forum', { settings: { thread_url: 'https://forum.example.test/t/1', title: 'T' } })), ['FORUM_TARGET_BOTH'])
    assert.deepEqual(codes(check('forum', { settings: { thread_url: 'firul' } })), ['FORUM_THREAD_INVALID'])
  })

  it('Presa: a press release has a title (and a lead as the subtitle)', () => {
    assert.equal(check('press', { settings: { title: 'Un comunicat', subtitle: 'Leadul' } }).ok, true)
    assert.deepEqual(codes(check('press')), ['TITLE_MISSING'])
    assert.deepEqual(codes(check('press', { text: a(50001), settings: { title: 'T' } })), ['TOO_LONG'])
  })
})

describe('manual channels (amendment 05): drafts and handoff', () => {
  const fixture = (name: string) => {
    const { name: _name, ...draft } = DRAFT_FIXTURES.find((f) => f.name === name)!
    return DraftSchema.parse({ ...draft, client_ref: name })
  }
  const accounts = [
    ...BATCH3.map((platform) => ({ id: `acc-${platform}`, platform, display_name: platform })),
    { id: 'acc-forum-2', platform: 'forum' as const, display_name: 'Forum Softpedia' },
  ]

  it('social fixture: one destination per account, with the blockers a person must clear', () => {
    const mapped = mapDraft(fixture('manual-channels'), accounts, { now: NOW })
    assert.equal(mapped.destinations.length, 7, 'two forum accounts, two forum destinations')
    const by = (id: string) => mapped.destinations.find((d) => d.account_id === id)!
    const blockers = (id: string) => by(id).validation.errors.map((e) => e.code).sort()
    assert.deepEqual(blockers('acc-quora'), ['QUORA_TARGET_MISSING'])
    assert.deepEqual(blockers('acc-tradingview'), ['TRADINGVIEW_SYMBOL_MISSING'])
    assert.deepEqual(blockers('acc-investing'), ['INVESTING_INSTRUMENT_MISSING'])
    assert.deepEqual(blockers('acc-indiehackers'), [])
    assert.deepEqual(blockers('acc-stackexchange'), ['SE_QUESTION_MISSING'])
    assert.deepEqual(by('acc-stackexchange').settings, { site: 'money.stackexchange.com', post_type: 'answer' })
    assert.deepEqual(blockers('acc-forum'), [])
    assert.deepEqual(blockers('acc-forum-2'), [])
  })

  it('article fixture: LinkedIn article, GitHub release and press release take the article', () => {
    const mapped = mapDraft(fixture('manual-articles'), accounts, { now: NOW })
    assert.equal(mapped.destinations.length, 3)
    const by = (p: string) => mapped.destinations.find((d) => d.platform === p)!
    assert.deepEqual(by('linkedin-article').settings, { title: 'Taxes Support lanseaza un ghid pentru Declaratia Unica', subtitle: 'Pasii pentru castigurile din crypto, explicati calm' })
    assert.deepEqual(by('linkedin-article').validation.errors, [])
    assert.deepEqual(by('press').validation.errors, [])
    assert.deepEqual(by('github').settings, { post_type: 'release', title: 'Taxes Support lanseaza un ghid pentru Declaratia Unica' })
    assert.deepEqual(by('github').validation.errors.map((e) => e.code).sort(), ['GITHUB_REPO_MISSING', 'GITHUB_TAG_MISSING'])
    assert.match(by('press').text, /Despre Taxes Support/)
  })

  it('handoff: the fields each site asks for, the right body label and a checklist', () => {
    const se = buildHandoff({ platform: 'stackexchange', kind: 'social', title: null, text: TEXT, settings: { site: 'money.stackexchange.com', post_type: 'answer', question_url: OURS } })
    assert.deepEqual(se.fields.map((f) => [f.key, f.value]), [['site', 'money.stackexchange.com'], ['post_type', 'Raspuns'], ['question_url', OURS]])
    assert.match(se.checklist.join(' '), /Afilierea este declarata/)
    const gh = buildHandoff({ platform: 'github', kind: 'article', title: 'T', text: '# Note\n\nO **schimbare**.', settings: { repo: 'org/proiect', post_type: 'release', title: 'v1.2.0', tag: 'v1.2.0' } })
    assert.deepEqual(gh.fields.map((f) => [f.key, f.value]), [['repo', 'org/proiect'], ['post_type', 'Release'], ['title', 'v1.2.0'], ['tag', 'v1.2.0']])
    assert.match(gh.body.html, /<strong>schimbare<\/strong>/)
    const press = buildHandoff({ platform: 'press', kind: 'article', title: 'T', text: 'Corp', settings: { title: 'Comunicat', subtitle: 'Lead' } })
    assert.deepEqual(press.fields.map((f) => [f.key, f.value]), [['title', 'Comunicat'], ['subtitle', 'Lead']])
    assert.equal(press.body.label, 'Comunicat')
    assert.match(press.checklist.join(' '), /redactiei/)
    const tv = buildHandoff({ platform: 'tradingview', kind: 'social', title: null, text: TEXT, settings: { symbol: 'BINANCE:BTCUSDT', title: 'Idee' } })
    assert.match(tv.checklist.join(' '), /desenat/)
    for (const p of BATCH3) assert.ok(buildHandoff({ platform: p, kind: PLATFORM_KIND[p], title: 'T', text: TEXT, settings: {} }).checklist.length >= 3, p)
  })
})

const TOKEN = 'manual-channels-token-0123456789abcdef'
let db: PGlite
let brand: string
let admin: { userId: string; email: string }
let api: WorkerApi

describe('migration 0010 and the manual accounts of amendment 05', () => {
  before(async () => {
    db = await migratedDb()
    setTestAdminClient(createFakeSupabase(db))
    brand = await brandId(db)
    admin = { userId: await adminUser(db), email: 'admin@example.test' }
    api = new WorkerApi({ baseUrl: 'http://127.0.0.1:3000', token: TOKEN, workerId: 'manual-channels-worker', fetch: routeFetch })
  })
  after(async () => {
    setTestAdminClient(null)
    setTestAdmin(null)
    await db.close()
  })
  beforeEach(async () => {
    await resetSocial(db)
    setTestAdmin(admin)
    process.env.WORKER_TOKEN = TOKEN
    process.env.SOCIAL_PUBLISHING_ENABLED = 'true'
  })

  it('the two SQL lists match the site constants', async () => {
    const known = (await rows(db, `select unnest(social_known_platforms()) as p`)).map((r) => r.p).sort()
    assert.deepEqual(known, [...PLATFORMS].sort())
    const manual = (await rows(db, `select unnest(social_manual_only_platforms()) as p`)).map((r) => r.p).sort()
    assert.deepEqual(manual, [...MANUAL_ONLY_PLATFORMS].sort())
    for (const p of BATCH3) assert.ok(manual.includes(p), p)
  })

  it('none of the nine can be automatic, by insert or by update', async () => {
    for (const p of BATCH3) {
      await assert.rejects(
        rows(db, `insert into social_accounts (platform, mode, status, postiz_integration_id, display_name) values ($1, 'auto', 'connected', $2, 'X')`, [p, `auto-${p}`]),
        /SOCIAL_MANUAL_ONLY_PLATFORM/,
        p
      )
    }
    const [{ id }] = await rows(db, `insert into social_accounts (brand_id, platform, mode, status, display_name) values ($1, 'quora', 'manual', 'manual', 'Q') returning id`, [brand])
    const r = await updateAccount(id, { mode: 'auto' })
    assert.equal(r.ok, false)
    assert.equal((await rows(db, `select mode from social_accounts where id = $1`, [id]))[0].mode, 'manual')
  })

  it('manual accounts are created by hand, one per forum and per outlet, with their own link', async () => {
    for (const [platform, name, link] of [
      ['forum', 'Forum Softpedia', 'https://forum.softpedia.example.test/'],
      ['forum', 'Rankia Romania', 'https://www.rankia.example.test/'],
      ['press', 'StartupCafe.ro', 'https://startupcafe.example.test/contact'],
      ['quora', 'Quora', null],
    ] as const) {
      const r = await createManualAccount({ platform, brandId: brand, displayName: name, openEditorUrl: link })
      assert.equal(r.ok, true, `${platform} ${name}: ${JSON.stringify(r)}`)
    }
    const accounts = await rows(db, `select platform, display_name, mode, status, open_editor_url, paused from social_accounts order by display_name`)
    assert.equal(accounts.length, 4)
    assert.ok(accounts.every((x) => x.mode === 'manual' && x.status === 'manual' && x.paused === false))
    assert.equal(accounts.find((x) => x.display_name === 'StartupCafe.ro')!.open_editor_url, 'https://startupcafe.example.test/contact')
    assert.equal(accounts.find((x) => x.platform === 'quora')!.open_editor_url, 'https://www.quora.com/')
    // Only https links: a mailto: address is refused, the outlet's contact page is used.
    const mail = await createManualAccount({ platform: 'press', brandId: brand, displayName: 'Redactia', openEditorUrl: 'mailto:redactie@example.test' })
    assert.equal(mail.ok, false)
  })

  it('a worker sync does not turn Postiz channels into any of the nine', async () => {
    assert.equal((await syncFakeAccounts(api)).status, 200)
    const synced = await rows(db, `select platform from social_accounts`)
    assert.equal(synced.length, FAKE_INTEGRATIONS.length)
    assert.ok(synced.every((x) => !(BATCH3 as readonly string[]).includes(x.platform)))
  })

  async function newPost(accountId: string, text: string, settings: Record<string, unknown>) {
    const [{ id }] = await rows(db, `select social_create_post($1::jsonb, $2::jsonb, $3::jsonb) as id`, [
      JSON.stringify({ brand_id: brand, kind: 'social', title: 'Titlu test', source_url: null, created_by: admin.userId }),
      JSON.stringify({ canonical_text: text, figures: [] }),
      JSON.stringify([{ account_id: accountId, text, settings, scheduled_at: null }]),
    ])
    return (await getPost(id))!
  }

  it('a forum account completes the manual handoff', async () => {
    const created = await createManualAccount({ platform: 'forum', brandId: brand, displayName: 'Forum Softpedia', openEditorUrl: 'https://forum.softpedia.example.test/' })
    assert.equal(created.ok, true)
    const [{ id: account }] = await rows(db, `select id from social_accounts where platform = 'forum'`)
    const post = await newPost(account, 'Un raspuns clar si recitit.', { thread_url: 'https://forum.softpedia.example.test/t/42' })
    const approved = await approvePost({
      postId: post.id,
      revisionId: post.revision.id,
      times: Object.fromEntries(post.destinations.map((d) => [d.account_id, toLocalInputs(new Date())])),
      figuresChecked: false,
    })
    assert.equal(approved.ok, true, JSON.stringify(approved))
    await runFakeWorkerOnce(api, { scenario: 'ok' })
    const [job] = await rows(db, `select id, status from social_delivery_jobs`)
    assert.equal(job.status, 'manual_pending', 'the worker never gets a forum job')
    const handoff = await getManualJob(job.id)
    assert.ok(handoff)
    assert.deepEqual(handoff.handoff.fields.map((f) => [f.key, f.value]), [['thread_url', 'https://forum.softpedia.example.test/t/42']])
    assert.deepEqual(await markManualPublished(job.id, 'https://forum.softpedia.example.test/t/42#p9'), { ok: true, alreadyDone: false })
    assert.equal((await rows(db, `select status from social_posts where id = $1`, [post.id]))[0].status, 'published')
  })
})
