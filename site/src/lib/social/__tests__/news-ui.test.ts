/**
 * Amendment 07 admin UI logic: the Genereaza form and its action, the sources
 * panel helpers and the automation card. The React components are thin; what
 * decides behaviour lives in news-ui.ts and is tested here.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PGlite } from '@electric-sql/pglite'
import { migratedDb } from '../../testing/pglite-db.ts'
import { createFakeSupabase } from '../../testing/fake-supabase.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { setTestAdmin } from '../../testing/auth-shim.ts'
import { adminUser, brandId, resetSocial, rows } from '../../testing/social-fixtures.ts'
import { createGenerationRequest } from '../actions.ts'
import { GenerationInputSchema } from '../schemas.ts'
import { RESEARCH_COST_HINT, SOURCES_APPROVAL_BLOCKED_HINT } from '../constants.ts'
import {
  approvalBlockedHint,
  automationRunTime,
  automationStatusLabel,
  automationStatusTone,
  automationWorkflowLabel,
  buildGenerationCandidate,
  buildGenerationForm,
  effectiveResearch,
  effectiveVerified,
  figureSourceUrl,
  formatSourcesForComment,
  generationIssueMessage,
  isSafeSourceUrl,
  parseHooks,
  parseWindowDays,
  requestSourceLabel,
  requestUsesResearch,
  sourceHost,
  sourceMeta,
  sourcesHeader,
  sourcesLocked,
  sourcesProgress,
  sourceTitle,
  summarizeRunDetails,
  verifierName,
  type GenerationFormState,
  type SourceLike,
} from '../news-ui.ts'

const state = (over: Partial<GenerationFormState> = {}): GenerationFormState => ({
  brandId: 'b1',
  mode: 'topic',
  url: '',
  topic: '  Declaratia Unica  ',
  hooks: 'termen, , schimbare de cota ',
  focus: '',
  windowDays: '7',
  webSearch: false,
  platforms: ['x', 'devto'],
  count: 3,
  templates: ['dark'],
  aiModel: '',
  ...over,
})

const source = (over: Partial<SourceLike> = {}): SourceLike => ({
  id: 's1',
  url: 'https://www.anaf.ro/ghid',
  title: 'Ghid ANAF',
  publisher: 'ANAF',
  published_at: '2026-10-01',
  note: 'termenul',
  found_in_search: true,
  verified_at: null,
  verified_by: null,
  ...over,
})

describe('research flag', () => {
  it('is implicit for news, opt-in for a topic and never for an article', () => {
    assert.equal(effectiveResearch('news', false), true)
    assert.equal(effectiveResearch('news', undefined), true)
    assert.equal(effectiveResearch('topic', true), true)
    assert.equal(effectiveResearch('topic', false), false)
    assert.equal(effectiveResearch('topic', undefined), false)
    assert.equal(effectiveResearch('article', true), false)
    assert.equal(effectiveResearch(undefined, true), false)
  })

  it('says what a search costs', () => {
    assert.equal(RESEARCH_COST_HINT, 'Cautarea pe web inseamna 2 apeluri AI si cel mult 5 cautari (cost suplimentar).')
  })
})

describe('Genereaza form input', () => {
  it('parses angles and the news window', () => {
    assert.deepEqual(parseHooks('a, ,b,'), ['a', 'b'])
    assert.equal(parseWindowDays('7'), 7)
    assert.equal(parseWindowDays(''), 7)
    assert.equal(parseWindowDays('abc'), 7)
    assert.equal(parseWindowDays('0'), 1)
    assert.equal(parseWindowDays('45'), 30)
    assert.equal(parseWindowDays('2.6'), 3)
    assert.equal(parseWindowDays(14), 14)
  })

  it('builds a topic source with trimmed text and the web search checkbox', () => {
    const plain = buildGenerationForm(state())
    assert.deepEqual(plain.source, { type: 'topic', topic: 'Declaratia Unica', hooks: ['termen', 'schimbare de cota'] })
    assert.equal(plain.research, false)
    assert.equal(buildGenerationForm(state({ webSearch: true })).research, true)
  })

  it('builds a news source: optional focus, window in days, research always on', () => {
    const news = buildGenerationForm(state({ mode: 'news', focus: '  criptomonede ', windowDays: '14', webSearch: false }))
    assert.deepEqual(news.source, { type: 'news', topic: 'criptomonede', window_days: 14 })
    assert.equal(news.research, true)
    const noFocus = buildGenerationForm(state({ mode: 'news', focus: '   ', windowDays: '' }))
    assert.deepEqual(noFocus.source, { type: 'news', topic: '', window_days: 7 })
  })

  it('never turns on research for an article, even with the box left ticked', () => {
    const article = buildGenerationForm(state({ mode: 'article', url: ' https://thecrypto.support/ghid ', webSearch: true }))
    assert.deepEqual(article.source, { type: 'article', url: 'https://thecrypto.support/ghid' })
    assert.equal(article.research, false)
  })

  it('does not carry the text of one source into another', () => {
    const news = buildGenerationForm(state({ mode: 'news', topic: 'subiect de topic', focus: '' }))
    assert.equal((news.source as { topic: string }).topic, '')
  })
})

describe('what the action validates', () => {
  const parse = (over: Partial<GenerationFormState>) => {
    const built = buildGenerationCandidate(buildGenerationForm(state(over)))
    assert.equal(built.ok, true)
    return GenerationInputSchema.safeParse((built as { candidate: unknown }).candidate)
  }

  it('accepts the three sources and keeps research on the parsed input', () => {
    const topic = parse({})
    assert.equal(topic.success, true)
    assert.equal(topic.data?.research, false)
    const searched = parse({ webSearch: true })
    assert.equal(searched.success && searched.data.research, true)
    const news = parse({ mode: 'news', focus: '', windowDays: '30' })
    assert.equal(news.success, true)
    assert.deepEqual(news.data?.source, { type: 'news', topic: '', window_days: 30 })
    assert.equal(news.data?.research, true)
    const article = parse({ mode: 'article', url: 'https://thecrypto.support/ghid' })
    assert.equal(article.success && article.data.research, false)
  })

  it('treats the browser as untrusted: a hand made form is cleaned or refused', () => {
    const forged = buildGenerationCandidate({
      brandId: 'b1',
      source: { type: 'article', url: 'https://thecrypto.support/ghid' },
      research: true,
      platforms: ['x'],
      count: 1,
      templates: ['dark'],
    })
    assert.equal(forged.ok && forged.candidate.research, false, 'an article cannot ask for research')
    const odd = buildGenerationCandidate({ brandId: 'b1', source: { type: 'rss' } as never, platforms: ['x'], count: 1, templates: ['dark'] })
    assert.equal(odd.ok && GenerationInputSchema.safeParse(odd.candidate).success, false)
    const badModel = buildGenerationCandidate({ ...buildGenerationForm(state()), aiModel: 'gpt-5' })
    assert.deepEqual(badModel, { ok: false, error: 'Alege un model AI din lista.' })
  })

  it('keeps the picked AI model and the platform kinds', () => {
    const built = buildGenerationCandidate(buildGenerationForm(state({ aiModel: 'gemini-3.7-flash', platforms: ['x', 'devto', 'producthunt'] })))
    assert.ok(built.ok)
    assert.deepEqual(built.candidate.ai, { provider: 'gemini', model: 'gemini-3.7-flash' })
    assert.deepEqual(built.candidate.kinds, ['social', 'article', 'launch'])
  })

  it('has a readable message for each field it can refuse', () => {
    const issue = (over: Partial<GenerationFormState>) => {
      const r = parse(over)
      assert.equal(r.success, false)
      const e = (r as { error: { issues: Array<{ path: PropertyKey[] }> } }).error
      return generationIssueMessage(e.issues[0].path.join('.'), over.mode === 'news' ? 'news' : 'topic')
    }
    assert.match(issue({ topic: 'ab' }), /cel putin 3/)
    assert.match(issue({ mode: 'news', focus: 'x'.repeat(501) }), /cel mult 500/)
    assert.match(issue({ mode: 'article', url: 'ftp://x' }), /https/)
    assert.match(generationIssueMessage('source.window_days', 'news'), /intre 1 si 30/)
    assert.match(issue({ platforms: [] }), /platforma/)
    assert.match(issue({ count: 21 }), /1 si 20/)
    assert.equal(generationIssueMessage('', undefined), 'Date invalide (formular).')
  })

  it('refuses a news window outside 1..30 at the schema, whatever the form says', () => {
    for (const window_days of [0, 31, 2.5, Number.NaN]) {
      const built = buildGenerationCandidate({
        brandId: 'b1',
        source: { type: 'news', topic: '', window_days },
        platforms: ['x'],
        count: 1,
        templates: ['dark'],
      })
      assert.ok(built.ok)
      const r = GenerationInputSchema.safeParse(built.candidate)
      assert.equal(r.success, false, `window_days ${window_days}`)
      assert.match(generationIssueMessage(r.error?.issues[0].path.join('.') ?? '', 'news'), /intre 1 si 30/)
    }
  })
})

describe('requests list', () => {
  it('labels each kind of source', () => {
    assert.equal(requestSourceLabel({ type: 'article', url: 'https://x.ro/a' }), 'https://x.ro/a')
    assert.equal(requestSourceLabel({ type: 'topic', topic: 'Taxe' }), 'Taxe')
    assert.equal(requestSourceLabel({ type: 'news', topic: 'Taxe', window_days: 7 }), 'Stiri recente: Taxe')
    assert.equal(requestSourceLabel({ type: 'news', topic: '', window_days: 7 }), 'Stiri recente (temele brandului)')
    assert.equal(requestSourceLabel(undefined), '-')
    assert.equal(requestSourceLabel({ type: 'rss' }), '-')
  })

  it('flags a request that searches the web', () => {
    assert.equal(requestUsesResearch({ source: { type: 'news' } }), true)
    assert.equal(requestUsesResearch({ source: { type: 'topic' }, research: true }), true)
    assert.equal(requestUsesResearch({ source: { type: 'topic' } }), false)
    assert.equal(requestUsesResearch({ source: { type: 'article' }, research: false }), false)
    assert.equal(requestUsesResearch(undefined), false)
  })
})

describe('sources panel', () => {
  it('shows only http(s) links', () => {
    assert.equal(isSafeSourceUrl('https://anaf.ro/x'), true)
    assert.equal(isSafeSourceUrl('http://anaf.ro/x'), true)
    assert.equal(isSafeSourceUrl('javascript:alert(1)'), false)
    assert.equal(isSafeSourceUrl('data:text/html,hi'), false)
    assert.equal(isSafeSourceUrl('//anaf.ro/x'), false)
    assert.equal(isSafeSourceUrl(''), false)
    assert.equal(isSafeSourceUrl(null), false)
    assert.equal(sourceHost('https://www.anaf.ro/ghid'), 'anaf.ro')
    assert.equal(sourceHost('javascript:alert(1)'), '')
  })

  it('names a source by title, then publisher, then site', () => {
    assert.equal(sourceTitle(source()), 'Ghid ANAF')
    assert.equal(sourceTitle(source({ title: '  ', publisher: 'ANAF' })), 'ANAF')
    assert.equal(sourceTitle(source({ title: '', publisher: null })), 'anaf.ro')
    assert.equal(sourceTitle(source({ title: '', publisher: null, url: 'x' })), 'Sursa fara titlu')
    assert.equal(sourceTitle(source({ title: 'Doua\nranduri   si spatii' })), 'Doua randuri si spatii')
  })

  it('describes publisher, site and date', () => {
    assert.equal(sourceMeta(source()), 'ANAF · anaf.ro · 2026-10-01')
    assert.equal(sourceMeta(source({ publisher: null, published_at: null })), 'anaf.ro')
  })

  it('does not show a bare id as the verifier', () => {
    assert.equal(verifierName('owner@example.test'), 'owner@example.test')
    assert.equal(verifierName('0b6f3f0a-6a43-4f6e-8c52-3f1e2d4a9c10'), null)
    assert.equal(verifierName(null), null)
    assert.equal(verifierName('  '), null)
  })

  it('shows a click at once, then lets the server win', () => {
    assert.equal(effectiveVerified(false, undefined), false)
    assert.equal(effectiveVerified(false, { value: true, base: false }), true, 'optimistic until the refresh')
    assert.equal(effectiveVerified(true, { value: true, base: false }), true, 'the server caught up')
    assert.equal(effectiveVerified(true, { value: false, base: false }), true, 'someone else changed it: the server wins')
    assert.equal(effectiveVerified(true, { value: false, base: true }), false, 'an untick')
  })

  it('counts verified sources, with optimistic clicks', () => {
    const list = [source({ id: 'a', verified_at: '2026-10-10T08:00:00Z' }), source({ id: 'b' }), source({ id: 'c' })]
    assert.deepEqual(sourcesProgress(list), { verified: 1, total: 3, unverified: 2 })
    assert.deepEqual(sourcesProgress(list, { b: { value: true, base: false } }), { verified: 2, total: 3, unverified: 1 })
    assert.deepEqual(sourcesProgress([]), { verified: 0, total: 0, unverified: 0 })
    assert.equal(sourcesHeader(1, 3), '1 din 3 verificate')
  })

  it('warns about approval only while a source is unticked', () => {
    assert.equal(approvalBlockedHint(2), 'Aprobarea e blocata pana verifici toate sursele.')
    assert.equal(approvalBlockedHint(2), SOURCES_APPROVAL_BLOCKED_HINT)
    assert.equal(approvalBlockedHint(0), null)
  })

  it('freezes the ticks once the post is approved', () => {
    assert.equal(sourcesLocked('draft'), false)
    assert.equal(sourcesLocked('cancelled'), false)
    for (const status of ['approved', 'publishing', 'published', 'partial', 'failed']) assert.equal(sourcesLocked(status), true, status)
  })

  it('formats the LinkedIn first comment', () => {
    const list = [
      source(),
      source({ id: 's2', url: 'https://bnr.ro/curs', title: 'Curs BNR', publisher: null }),
      source({ id: 's3', url: 'https://mfinante.gov.ro/x', title: '', publisher: 'MFP' }),
      source({ id: 's4', url: 'javascript:alert(1)', title: 'Rau' }),
    ]
    assert.equal(
      formatSourcesForComment(list),
      ['Surse:', '- Ghid ANAF (ANAF): https://www.anaf.ro/ghid', '- Curs BNR: https://bnr.ro/curs', '- mfinante.gov.ro (MFP): https://mfinante.gov.ro/x'].join('\n')
    )
    assert.equal(formatSourcesForComment([]), '')
    assert.equal(formatSourcesForComment([source({ url: 'ftp://x' })]), '')
  })

  it('links a web figure to its page, and only over http(s)', () => {
    assert.equal(figureSourceUrl({ value: '16%', source_url: ' https://anaf.ro/x ' }), 'https://anaf.ro/x')
    assert.equal(figureSourceUrl({ value: '16%', source_url: 'javascript:alert(1)' }), null)
    assert.equal(figureSourceUrl({ value: '16%', source_url: null }), null)
    assert.equal(figureSourceUrl({ value: '16%' }), null)
    assert.equal(figureSourceUrl(undefined), null)
  })
})

describe('automation card', () => {
  it('labels the status and the known workflows', () => {
    assert.equal(automationStatusLabel('ok'), 'Reusit')
    assert.equal(automationStatusLabel('error'), 'Eroare')
    assert.equal(automationStatusLabel('skipped'), 'Sarit')
    assert.equal(automationStatusLabel('weird'), 'weird')
    assert.equal(automationStatusTone('ok'), 'accent')
    assert.equal(automationStatusTone('error'), 'danger')
    assert.equal(automationStatusTone('skipped'), 'neutral')
    assert.equal(automationWorkflowLabel('news-to-drafts'), 'Stiri in ciorne')
    assert.equal(automationWorkflowLabel('my-flow'), 'my-flow')
  })

  it('shows the time of the last report', () => {
    const run = { id: '1', workflow: 'w', status: 'ok', created_at: '2026-10-10T05:00:00Z', updated_at: '2026-10-10T05:05:00Z' }
    assert.equal(automationRunTime(run), '2026-10-10T05:05:00Z')
    assert.equal(automationRunTime({ ...run, updated_at: null }), '2026-10-10T05:00:00Z')
  })

  it('summarizes details in one short line', () => {
    assert.equal(summarizeRunDetails(null), '')
    assert.equal(summarizeRunDetails({}), '')
    assert.equal(summarizeRunDetails('  un   text '), 'un text')
    assert.equal(summarizeRunDetails({ error: 'SMTP refuzat', events: 3 }), 'SMTP refuzat')
    assert.equal(summarizeRunDetails({ brand: 'taxes', requests: 2, created: true, extra: 'nu' }), 'brand: taxes · requests: 2 · created: true')
    assert.equal(summarizeRunDetails({ nested: { a: 1 }, list: [1, 2] }), '')
    assert.equal(summarizeRunDetails([1, 2, 3]), '3 elemente')
    const long = summarizeRunDetails({ message: 'x'.repeat(300) })
    assert.equal(long.length, 120)
    assert.ok(long.endsWith('...'))
  })
})

describe('createGenerationRequest with the amendment 07 input', () => {
  let db: PGlite
  let brand: string
  let admin: { userId: string; email: string }
  const base = { platforms: ['x'] as never, count: 2, templates: ['dark' as const] }
  const inputs = async () => (await rows(db, `select input from social_generation_requests order by created_at`)).map((r) => r.input as Record<string, unknown>)

  before(async () => {
    db = await migratedDb()
    setTestAdminClient(createFakeSupabase(db))
    brand = await brandId(db)
    admin = { userId: await adminUser(db), email: 'admin@example.test' }
    setTestAdmin(admin)
  })
  after(async () => {
    setTestAdmin(null)
    await db.close()
  })
  beforeEach(async () => {
    setTestAdmin(admin)
    await resetSocial(db)
  })

  it('stores a news request: window, empty focus, research on', async () => {
    const r = await createGenerationRequest({ brandId: brand, source: { type: 'news', topic: '', window_days: 14 }, ...base })
    assert.equal(r.ok, true, JSON.stringify(r))
    const [input] = await inputs()
    assert.deepEqual(input.source, { type: 'news', topic: '', window_days: 14 })
    assert.equal(input.research, true)
    const [log] = await rows(db, `select details from social_activity_log where action = 'social.generation_requested'`)
    assert.equal((log.details as { source: string; research: boolean }).source, 'news')
    assert.equal((log.details as { research: boolean }).research, true)
  })

  it('stores a topic with the web search box, and without it', async () => {
    const topic = { type: 'topic' as const, topic: 'Declaratia Unica', hooks: [] }
    assert.equal((await createGenerationRequest({ brandId: brand, source: topic, research: true, ...base })).ok, true)
    assert.equal((await createGenerationRequest({ brandId: brand, source: topic, ...base })).ok, true)
    const [searched, plain] = await inputs()
    assert.equal(searched.research, true)
    assert.equal(plain.research, false)
  })

  it('ignores research on an article', async () => {
    const r = await createGenerationRequest({ brandId: brand, source: { type: 'article', url: 'https://thecrypto.support/ghid' }, research: true, ...base })
    assert.equal(r.ok, true)
    assert.equal((await inputs())[0].research, false)
  })

  it('refuses a bad window with a readable message and stores nothing', async () => {
    const r = await createGenerationRequest({ brandId: brand, source: { type: 'news', topic: '', window_days: 99 }, ...base })
    assert.equal(r.ok, false)
    assert.match((r as { error: string }).error, /intre 1 si 30/)
    assert.equal((await rows(db, `select 1 from social_generation_requests`)).length, 0)
  })

  it('refuses every news request without an admin session', async () => {
    setTestAdmin(null)
    try {
      const r = await createGenerationRequest({ brandId: brand, source: { type: 'news', topic: '', window_days: 7 }, ...base })
      assert.equal(r.ok, false)
      assert.equal((await rows(db, `select 1 from social_generation_requests`)).length, 0)
    } finally {
      setTestAdmin(admin)
    }
  })
})
