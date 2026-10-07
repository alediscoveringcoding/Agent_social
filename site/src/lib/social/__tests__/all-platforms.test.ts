/**
 * Amendment 04, second batch: every other Postiz provider. Slack, WordPress,
 * Listmonk, VK, Google Business, Tumblr, Dribbble, MeWe, Skool, Whop, Moltbook,
 * Kick, Twitch, TikTok and YouTube. YouTube is manual-only (it needs video);
 * TikTok publishes photo posts, so it is automatic with images.
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PGlite } from '@electric-sql/pglite'
import { migratedDb } from '../../testing/pglite-db.ts'
import { createFakeSupabase } from '../../testing/fake-supabase.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { setTestAdmin } from '../../testing/auth-shim.ts'
import { routeFetch } from '../../testing/route-fetch.ts'
import { adminUser, brandId, createAccount, resetSocial, rows } from '../../testing/social-fixtures.ts'
import {
  CARD_FORMATS,
  MANUAL_ONLY_PLATFORMS,
  MANUAL_ONLY_REASONS,
  PLATFORMS,
  PLATFORM_CARD_FORMAT,
  PLATFORM_KIND,
  PLATFORM_LABELS,
  PROVIDER_TO_PLATFORM,
  type Platform,
} from '../constants.ts'
import { findDiacritics } from '../content-rules.ts'
import { mapDraft } from '../draft-mapping.ts'
import { buildHandoff } from '../handoff.ts'
import { SETTINGS_FIELDS } from '../platform-settings.ts'
import { DraftSchema } from '../schemas.ts'
import { platformForProvider } from '../sync-rules.ts'
import { validateDestination, type ValidateDestinationInput } from '../validation.ts'
import { DRAFT_FIXTURES } from '../fake/fixtures.ts'
import { FAKE_INTEGRATIONS, runFakeWorkerOnce, syncFakeAccounts } from '../fake/fake-worker.ts'
import { WorkerApi } from '../fake/worker-api-client.ts'
import { approvePost } from '../approval-actions.ts'
import { getPost } from '../approval-queries.ts'
import { updateAccount } from '../accounts-actions.ts'
import { markManualPublished } from '../handoff-actions.ts'
import { getManualJob } from '../handoff-queries.ts'
import { toLocalInputs } from '../time.ts'

const BATCH2 = ['slack', 'wordpress', 'listmonk', 'vk', 'gmb', 'tumblr', 'dribbble', 'mewe', 'skool', 'whop', 'moltbook', 'kick', 'twitch', 'tiktok', 'youtube'] as const satisfies readonly Platform[]
/** Every provider identifier of Postiz v2.25.0 (libraries/nestjs-libraries/src/integrations/social). */
const POSTIZ_IDENTIFIERS = [
  'x', 'linkedin', 'linkedin-page', 'facebook', 'instagram', 'instagram-standalone', 'threads', 'bluesky', 'mastodon', 'mastodon-custom',
  'reddit', 'pinterest', 'telegram', 'discord', 'slack', 'medium', 'devto', 'hashnode', 'wordpress', 'listmonk', 'wrapcast', 'nostr', 'lemmy',
  'vk', 'gmb', 'tumblr', 'dribbble', 'mewe', 'skool', 'whop', 'moltbook', 'kick', 'twitch', 'tiktok', 'tiktok-business', 'youtube',
]
const NOW = new Date('2026-11-01T08:00:00Z')
const LATER = '2026-11-02T08:00:00Z'
const TEXT = 'Afla ce trebuie sa stii despre declaratie.'
const OURS = 'https://thecrypto.support/ghid/impozit-crypto'

function check(platform: Platform, over: Partial<ValidateDestinationInput> = {}) {
  return validateDestination({ platform, text: TEXT, settings: {}, media: [], figures: [], scheduledAt: LATER, now: NOW, ...over })
}
const codes = (v: ReturnType<typeof check>) => v.errors.map((e) => e.code).sort()
const warns = (v: ReturnType<typeof check>) => v.warnings.map((e) => e.code).sort()
const image = (width = 1080, height = 1080, altText = 'Card despre declaratie') => ({ mediaId: 'm1', mime: 'image/png', width, height, altText })
const images = (n: number) => Array.from({ length: n }, (_, i) => ({ ...image(), mediaId: `m${i}` }))
const a = (n: number) => 'a'.repeat(n)

describe('every Postiz provider (amendment 04, second batch)', () => {
  it('the 36 Postiz identifiers map onto 33 platforms; aliases are not platforms', () => {
    assert.equal(POSTIZ_IDENTIFIERS.length, 36)
    const platforms = new Set<Platform>()
    for (const id of POSTIZ_IDENTIFIERS) {
      const p = platformForProvider(id)
      assert.ok(p, `${id} is mapped`)
      platforms.add(p)
    }
    assert.equal(platforms.size, 33)
    assert.equal(platformForProvider('instagram-standalone'), 'instagram')
    assert.equal(platformForProvider('mastodon-custom'), 'mastodon')
    assert.equal(platformForProvider('tiktok-business'), 'tiktok')
    assert.equal(platformForProvider('wrapcast'), 'farcaster')
    // Substack, Product Hunt and the nine manual channels of amendment 05 have no Postiz provider: 33 + 11 = 44 platforms.
    assert.equal(PLATFORMS.length, 44)
    assert.deepEqual(PLATFORMS.filter((p) => !platforms.has(p)).sort(), ['forum', 'github', 'indiehackers', 'investing', 'linkedin-article', 'press', 'producthunt', 'quora', 'stackexchange', 'substack', 'tradingview'])
    for (const target of Object.values(PROVIDER_TO_PLATFORM)) assert.ok((PLATFORMS as readonly string[]).includes(target), target)
  })

  it('labels, kinds, card formats and the manual-only list of the second batch', () => {
    for (const p of BATCH2) {
      assert.ok((PLATFORMS as readonly string[]).includes(p), p)
      assert.deepEqual(findDiacritics(PLATFORM_LABELS[p]), [], p)
      assert.ok(PLATFORM_CARD_FORMAT[p] in CARD_FORMATS, `${p} card format`)
      assert.equal(PLATFORM_KIND[p], p === 'wordpress' || p === 'listmonk' ? 'article' : 'social', p)
    }
    assert.equal(new Set(PLATFORMS.map((p) => PLATFORM_LABELS[p])).size, PLATFORMS.length, 'labels are unique')
    assert.deepEqual(CARD_FORMATS.dribbble, { width: 800, height: 600 })
    assert.equal(PLATFORM_CARD_FORMAT.dribbble, 'dribbble')
    assert.equal(PLATFORM_CARD_FORMAT.gmb, 'dribbble')
    assert.equal(PLATFORM_CARD_FORMAT.tiktok, 'portrait')
    assert.deepEqual([...MANUAL_ONLY_PLATFORMS].slice(0, 3), ['substack', 'producthunt', 'youtube'])
    assert.match(MANUAL_ONLY_REASONS.youtube ?? '', /video/)
    for (const p of BATCH2) if (p !== 'youtube') assert.ok(!MANUAL_ONLY_PLATFORMS.includes(p), `${p} is automatic`)
    for (const p of ['slack', 'wordpress', 'listmonk', 'gmb', 'tumblr', 'dribbble', 'mewe', 'skool', 'whop', 'moltbook', 'twitch', 'tiktok', 'youtube'] as const) {
      assert.ok(p in SETTINGS_FIELDS, `${p} has editor fields`)
    }
  })

  it('Slack: a channel id, 40,000 characters', () => {
    assert.equal(check('slack', { settings: { channel: 'C0123ABCD' } }).ok, true)
    assert.deepEqual(codes(check('slack')), ['SLACK_CHANNEL_MISSING'])
    assert.deepEqual(codes(check('slack', { settings: { channel: 'general' } })), ['SLACK_CHANNEL_INVALID'])
    assert.equal(check('slack', { text: a(40000), settings: { channel: 'C0123ABCD' } }).ok, true)
    assert.deepEqual(codes(check('slack', { text: a(40001), settings: { channel: 'C0123ABCD' } })), ['TOO_LONG'])
  })

  it('WordPress is an article: title required, status and type checked, one featured image', () => {
    assert.equal(check('wordpress', { settings: { title: 'Un titlu' } }).ok, true)
    assert.equal(check('wordpress', { settings: { title: 'Un titlu', post_type: 'page', status: 'draft' } }).ok, true)
    assert.deepEqual(codes(check('wordpress')), ['TITLE_MISSING'])
    assert.deepEqual(codes(check('wordpress', { settings: { title: 'T', status: 'live' } })), ['WORDPRESS_STATUS_INVALID'])
    assert.deepEqual(codes(check('wordpress', { settings: { title: 'T', post_type: 'Post Type' } })), ['WORDPRESS_TYPE_INVALID'])
    assert.deepEqual(codes(check('wordpress', { settings: { title: 'T' }, media: images(2) })), ['TOO_MANY_IMAGES'])
    assert.equal(check('wordpress', { text: a(100000), settings: { title: 'T' } }).ok, true)
    assert.deepEqual(codes(check('wordpress', { text: a(100001), settings: { title: 'T' } })), ['TOO_LONG'])
  })

  it('Listmonk is an article: subject and list id required, no length limit that matters', () => {
    assert.equal(check('listmonk', { settings: { title: 'Subiect', subtitle: 'Previzualizare', list: '3' } }).ok, true)
    const none = check('listmonk')
    assert.deepEqual(codes(none), ['LISTMONK_LIST_MISSING', 'TITLE_MISSING'])
    assert.match(none.errors.find((e) => e.code === 'TITLE_MISSING')!.message, /subiect/)
    assert.deepEqual(codes(check('listmonk', { settings: { title: 'S', list: 'abc' } })), ['LISTMONK_LIST_INVALID'])
    assert.deepEqual(codes(check('listmonk', { settings: { title: 'S', list: '3', template: 'x' } })), ['LISTMONK_TEMPLATE_INVALID'])
    assert.equal(check('listmonk', { text: a(200000), settings: { title: 'S', list: '3' } }).ok, true)
  })

  it('VK: 2,048 characters, no settings', () => {
    assert.equal(check('vk', { text: a(2048) }).ok, true)
    assert.deepEqual(codes(check('vk', { text: a(2049) })), ['TOO_LONG'])
  })

  it('Google Business: 1,500 characters, one image, a button that needs a link', () => {
    assert.equal(check('gmb').ok, true)
    assert.equal(check('gmb', { text: a(1500) }).ok, true)
    assert.deepEqual(codes(check('gmb', { text: a(1501) })), ['TOO_LONG'])
    assert.deepEqual(codes(check('gmb', { media: images(2) })), ['TOO_MANY_IMAGES'])
    assert.deepEqual(codes(check('gmb', { settings: { cta_type: 'LEARN_MORE' } })), ['GMB_CTA_URL_MISSING'])
    assert.deepEqual(codes(check('gmb', { settings: { cta_type: 'LEARN_MORE', cta_url: 'nu e link' } })), ['GMB_CTA_URL_INVALID'])
    assert.equal(check('gmb', { settings: { cta_type: 'LEARN_MORE', cta_url: OURS } }).ok, true)
    assert.equal(check('gmb', { settings: { cta_type: 'CALL' } }).ok, true, 'a call button uses the profile phone number')
    assert.deepEqual(codes(check('gmb', { settings: { cta_type: 'BUY' } })), ['GMB_CTA_INVALID'])
  })

  it('Tumblr: 32,768 characters, 30 images, optional title, links and tags', () => {
    assert.equal(check('tumblr').ok, true)
    assert.equal(check('tumblr', { text: a(32768) }).ok, true)
    assert.deepEqual(codes(check('tumblr', { text: a(32769) })), ['TOO_LONG'])
    assert.equal(check('tumblr', { media: images(30) }).ok, true)
    assert.deepEqual(codes(check('tumblr', { media: images(31) })), ['TOO_MANY_IMAGES'])
    assert.deepEqual(codes(check('tumblr', { settings: { link: 'x' } })), ['TUMBLR_LINK_INVALID'])
    assert.deepEqual(codes(check('tumblr', { settings: { source_url: 'x' } })), ['TUMBLR_LINK_INVALID'])
    assert.equal(check('tumblr', { settings: { link: OURS, source_url: OURS, title: 'Titlu', tags: ['taxe', 'crypto'] } }).ok, true)
    assert.deepEqual(codes(check('tumblr', { settings: { title: a(4097) } })), ['TUMBLR_TITLE_TOO_LONG'])
    assert.deepEqual(codes(check('tumblr', { settings: { tags: [a(3000), a(1200)] } })), ['TUMBLR_TAGS_TOO_LONG'])
  })

  it('Dribbble: exactly one 400x300 or 800x600 image, and a title', () => {
    const shot = [image(800, 600)]
    assert.equal(check('dribbble', { settings: { title: 'Un shot' }, media: shot }).ok, true)
    assert.equal(check('dribbble', { settings: { title: 'Un shot' }, media: [image(400, 300)] }).ok, true)
    assert.deepEqual(codes(check('dribbble')), ['DRIBBBLE_NO_IMAGE', 'DRIBBBLE_TITLE_MISSING'])
    assert.deepEqual(codes(check('dribbble', { settings: { title: 'T' }, media: [image(1000, 1500)] })), ['DRIBBBLE_IMAGE_SIZE'])
    assert.deepEqual(codes(check('dribbble', { settings: { title: 'T' }, media: [image(800, 600), image(800, 600)] })), ['TOO_MANY_IMAGES'])
    assert.deepEqual(codes(check('dribbble', { settings: { title: 'T', team: 'x' }, media: shot })), ['DRIBBBLE_TEAM_INVALID'])
    assert.equal(check('dribbble', { settings: { title: 'T', team: 'https://dribbble.com/echipa' }, media: shot }).ok, true)
    assert.deepEqual(codes(check('dribbble', { text: a(40001), settings: { title: 'T' }, media: shot })), ['TOO_LONG'])
  })

  it('MeWe: profile or group', () => {
    assert.equal(check('mewe').ok, true)
    assert.equal(check('mewe', { settings: { post_type: 'timeline' } }).ok, true)
    assert.deepEqual(codes(check('mewe', { settings: { post_type: 'group' } })), ['MEWE_GROUP_MISSING'])
    assert.equal(check('mewe', { settings: { post_type: 'group', group: '1234' } }).ok, true)
    assert.deepEqual(codes(check('mewe', { settings: { post_type: 'feed' } })), ['MEWE_TYPE_INVALID'])
    assert.equal(check('mewe', { text: a(63206) }).ok, true)
    assert.deepEqual(codes(check('mewe', { text: a(63207) })), ['TOO_LONG'])
  })

  it('Skool: group, category and title; 5,000 characters', () => {
    const ok = { group: 'taxes-ro', label: 'abc123', title: 'Un titlu' }
    assert.equal(check('skool', { settings: ok }).ok, true)
    assert.deepEqual(codes(check('skool')), ['SKOOL_GROUP_MISSING', 'SKOOL_LABEL_MISSING', 'SKOOL_TITLE_MISSING'])
    assert.equal(check('skool', { text: a(5000), settings: ok }).ok, true)
    assert.deepEqual(codes(check('skool', { text: a(5001), settings: ok })), ['TOO_LONG'])
  })

  it('Whop: company and forum ids; 50,000 characters', () => {
    const ok = { company: 'biz_abc', experience: 'exp_abc' }
    assert.equal(check('whop', { settings: ok }).ok, true)
    assert.deepEqual(codes(check('whop')), ['WHOP_COMPANY_MISSING', 'WHOP_EXPERIENCE_MISSING'])
    assert.deepEqual(codes(check('whop', { text: a(50001), settings: ok })), ['TOO_LONG'])
  })

  it('Moltbook, Kick and Twitch are text only: 300 and 500 characters, an image only warns', () => {
    assert.equal(check('moltbook', { text: a(300) }).ok, true)
    assert.deepEqual(codes(check('moltbook', { text: a(301) })), ['TOO_LONG'])
    for (const p of ['moltbook', 'kick', 'twitch'] as const) assert.deepEqual(warns(check(p, { media: images(1) })), ['TEXT_ONLY'], p)
    for (const p of ['kick', 'twitch'] as const) {
      assert.equal(check(p, { text: a(500) }).ok, true, p)
      assert.deepEqual(codes(check(p, { text: a(501) })), ['TOO_LONG'], p)
    }
    assert.equal(check('twitch', { settings: { message_type: 'announcement', announcement_color: 'blue' } }).ok, true)
    assert.deepEqual(codes(check('twitch', { settings: { message_type: 'shout' } })), ['TWITCH_TYPE_INVALID'])
    assert.deepEqual(codes(check('twitch', { settings: { announcement_color: 'pink' } })), ['TWITCH_COLOR_INVALID'])
  })

  it('TikTok publishes photo posts: at least one image, none over 1080px on the short side, a 90-character title', () => {
    const ok = { title: 'Un titlu', privacy_level: 'SELF_ONLY' }
    const v = check('tiktok', { settings: ok, media: [image(1080, 1350)] })
    assert.equal(v.ok, true, JSON.stringify(v.errors))
    assert.deepEqual(codes(check('tiktok', { settings: ok })), ['TIKTOK_NO_IMAGE'])
    assert.equal(check('tiktok', { settings: ok, media: [image(1600, 900)] }).ok, true)
    assert.deepEqual(codes(check('tiktok', { settings: ok, media: [image(1200, 1600)] })), ['TIKTOK_IMAGE_SIZE'])
    assert.equal(check('tiktok', { settings: ok, media: images(35) }).ok, true)
    assert.deepEqual(codes(check('tiktok', { settings: ok, media: images(36) })), ['TOO_MANY_IMAGES'])
    assert.equal(check('tiktok', { settings: { title: a(90) }, media: images(1) }).ok, true)
    assert.deepEqual(codes(check('tiktok', { settings: { title: a(91) }, media: images(1) })), ['TIKTOK_TITLE_TOO_LONG'])
    assert.deepEqual(codes(check('tiktok', { settings: { privacy_level: 'EVERYONE' }, media: images(1) })), ['TIKTOK_PRIVACY_INVALID'])
    assert.deepEqual(codes(check('tiktok', { text: a(2001), settings: ok, media: images(1) })), ['TOO_LONG'])
  })

  it('YouTube needs video: the app can only hand it over, with a warning, a title and a tag budget', () => {
    const v = check('youtube', { settings: { title: 'Un titlu' } })
    assert.equal(v.ok, true, 'a manual handoff is allowed')
    assert.deepEqual(warns(v), ['YOUTUBE_NEEDS_VIDEO'])
    assert.deepEqual(codes(check('youtube')), ['YOUTUBE_TITLE_MISSING'])
    assert.equal(check('youtube', { settings: { title: a(100) } }).ok, true)
    assert.deepEqual(codes(check('youtube', { settings: { title: a(101) } })), ['YOUTUBE_TITLE_TOO_LONG'])
    assert.equal(check('youtube', { text: a(5000), settings: { title: 'T' } }).ok, true)
    assert.deepEqual(codes(check('youtube', { text: a(5001), settings: { title: 'T' } })), ['TOO_LONG'])
    assert.equal(check('youtube', { settings: { title: 'T', tags: [a(250), a(250)] } }).ok, true, '500 in all')
    assert.deepEqual(codes(check('youtube', { settings: { title: 'T', tags: [a(250), a(251)] } })), ['YOUTUBE_TAGS_TOO_LONG'])
    assert.deepEqual(codes(check('youtube', { settings: { title: 'T', tags: [`${a(124)} ${a(125)}`, a(250)] } })), ['YOUTUBE_TAGS_TOO_LONG'], 'a tag with a space counts two more')
  })
})

describe('drafts reach the second batch', () => {
  const fixture = (name: string) => {
    const { name: _name, ...draft } = DRAFT_FIXTURES.find((f) => f.name === name)!
    return DraftSchema.parse({ ...draft, client_ref: name })
  }
  const accounts = BATCH2.map((platform) => ({ id: `acc-${platform}`, platform, display_name: platform }))

  it('maps the fixture to a destination per account, with defaults and the blockers a person must clear', () => {
    const draft = fixture('every-platform')
    assert.deepEqual(draft.variants.map((v) => v.platform).sort(), BATCH2.filter((p) => p !== 'wordpress' && p !== 'listmonk').sort())
    const mapped = mapDraft(draft, accounts, { now: NOW })
    assert.equal(mapped.destinations.length, 13)
    const by = (p: string) => mapped.destinations.find((d) => d.platform === p)!
    const blockers = (p: string) => by(p).validation.errors.map((e) => e.code).sort()
    assert.deepEqual(by('tiktok').settings, { privacy_level: 'SELF_ONLY', title: 'Declaratia Unica: termen 25 mai' })
    assert.deepEqual(by('mewe').settings, { post_type: 'timeline' })
    assert.deepEqual(by('twitch').settings, { message_type: 'message' })
    assert.deepEqual(by('dribbble').settings, { title: 'Declaratia Unica, 25 mai' })
    for (const p of ['vk', 'gmb', 'tumblr', 'mewe', 'moltbook', 'kick', 'twitch', 'youtube']) assert.deepEqual(blockers(p), [], p)
    assert.deepEqual(blockers('slack'), ['SLACK_CHANNEL_MISSING'])
    assert.deepEqual(blockers('dribbble'), ['DRIBBBLE_NO_IMAGE'])
    assert.deepEqual(blockers('skool'), ['SKOOL_GROUP_MISSING', 'SKOOL_LABEL_MISSING'])
    assert.deepEqual(blockers('whop'), ['WHOP_COMPANY_MISSING', 'WHOP_EXPERIENCE_MISSING'])
    assert.deepEqual(blockers('tiktok'), ['TIKTOK_NO_IMAGE'])
    assert.deepEqual(by('youtube').validation.warnings.map((w) => w.code), ['YOUTUBE_NEEDS_VIDEO'])
  })

  it('WordPress and Listmonk take the article: subject, preview line, body', () => {
    const mapped = mapDraft(fixture('article'), accounts.filter((x) => x.platform === 'wordpress' || x.platform === 'listmonk'), { now: NOW })
    const by = (p: string) => mapped.destinations.find((d) => d.platform === p)!
    assert.deepEqual(by('wordpress').settings, { title: 'Cum calculezi impozitul pe crypto', post_type: 'post', status: 'publish' })
    assert.deepEqual(by('wordpress').validation.errors, [])
    assert.match(by('wordpress').text, /^# Cum calculezi impozitul pe crypto/)
    assert.deepEqual(by('listmonk').settings, { title: 'Cum calculezi impozitul pe crypto', subtitle: 'Pas cu pas, fara surprize' })
    assert.deepEqual(by('listmonk').validation.errors.map((e) => e.code), ['LISTMONK_LIST_MISSING'])
  })
})

describe('manual handoff of the second batch', () => {
  it('YouTube says it needs video; WordPress and Listmonk show the fields their editors ask for', () => {
    const yt = buildHandoff({ platform: 'youtube', kind: 'social', title: null, text: 'Descrierea videoclipului.', settings: { title: 'Un titlu', tags: ['taxe', 'crypto'] } })
    assert.match(yt.notice ?? '', /video/)
    assert.deepEqual(yt.fields.map((f) => [f.key, f.value]), [['title', 'Un titlu'], ['tags', 'taxe, crypto']])
    assert.equal(yt.fields[0].max, 100)
    assert.equal(yt.body.label, 'Descriere')
    assert.match(yt.checklist.join(' '), /Videoclipul este incarcat/)
    assert.equal(buildHandoff({ platform: 'bluesky', kind: 'social', title: null, text: TEXT, settings: {} }).notice, undefined)

    const wp = buildHandoff({ platform: 'wordpress', kind: 'article', title: 'Titlu', text: '# Articol\n\nUn **ghid**.', settings: { title: 'Titlu', post_type: 'post', status: 'draft' } })
    assert.deepEqual(wp.fields.map((f) => [f.key, f.value]), [['title', 'Titlu'], ['post_type', 'post'], ['status', 'Ciorna']])
    assert.match(wp.body.html, /<strong>ghid<\/strong>/)
    const lm = buildHandoff({ platform: 'listmonk', kind: 'article', title: 'Titlu', text: 'Corp', settings: { title: 'Subiect', subtitle: 'Previzualizare', list: '3' } })
    assert.deepEqual(lm.fields.map((f) => [f.key, f.value]), [['title', 'Subiect'], ['subtitle', 'Previzualizare'], ['list', '3']])
    assert.equal(lm.body.label, 'Newsletter')

    const tt = buildHandoff({ platform: 'tiktok', kind: 'social', title: null, text: TEXT, settings: { title: 'Titlu', privacy_level: 'SELF_ONLY' } })
    assert.deepEqual(tt.fields.map((f) => [f.key, f.value]), [['title', 'Titlu'], ['privacy_level', 'Doar eu']])
    const gmb = buildHandoff({ platform: 'gmb', kind: 'social', title: null, text: TEXT, settings: { cta_type: 'LEARN_MORE', cta_url: OURS } })
    assert.deepEqual(gmb.fields.map((f) => f.value), ['Afla mai multe', OURS])
    for (const p of BATCH2) assert.ok(buildHandoff({ platform: p, kind: PLATFORM_KIND[p], title: 'T', text: TEXT, settings: {} }).checklist.length >= 2, p)
  })
})

const TOKEN = 'all-platforms-token-0123456789abcdef'
let db: PGlite
let brand: string
let admin: { userId: string; email: string }
let api: WorkerApi

describe('migration 0009 and YouTube as a manual account', () => {
  before(async () => {
    db = await migratedDb()
    setTestAdminClient(createFakeSupabase(db))
    brand = await brandId(db)
    admin = { userId: await adminUser(db), email: 'admin@example.test' }
    api = new WorkerApi({ baseUrl: 'http://127.0.0.1:3000', token: TOKEN, workerId: 'all-platforms-worker', fetch: routeFetch })
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

  it('accepts the 15 platforms and the dribbble card format; one function lists the manual-only ones', async () => {
    for (const platform of BATCH2) {
      const id = await createAccount(db, brand, platform)
      assert.ok(id, platform)
    }
    const names = (await rows(db, `select unnest(social_known_platforms()) as p`)).map((r) => r.p).sort()
    assert.deepEqual(names, [...PLATFORMS].sort())
    const manual = (await rows(db, `select unnest(social_manual_only_platforms()) as p`)).map((r) => r.p).sort()
    assert.deepEqual(manual, [...MANUAL_ONLY_PLATFORMS].sort())
    await rows(db, `insert into social_media(storage_path, sha256, mime, width, height, bytes, alt_text, source, format) values ('test/shot.png', repeat('d', 64), 'image/png', 800, 600, 100, 'Shot', 'generated', 'dribbble')`)
    await assert.rejects(
      rows(db, `insert into social_media(storage_path, sha256, mime, width, height, bytes, alt_text, source, format) values ('test/bad.png', repeat('e', 64), 'image/png', 800, 600, 100, 'Bad', 'generated', 'reel')`),
      /social_media_format_allowed/
    )
  })

  it('YouTube cannot be automatic, by insert or by update, and says so', async () => {
    await assert.rejects(
      rows(db, `insert into social_accounts (platform, mode, status, postiz_integration_id, display_name) values ('youtube', 'auto', 'connected', 'yt-auto', 'Y')`),
      /SOCIAL_MANUAL_ONLY_PLATFORM/
    )
    const [{ id }] = await rows(db, `insert into social_accounts (brand_id, platform, mode, status, postiz_integration_id, display_name) values ($1, 'youtube', 'manual', 'manual', 'yt-1', 'Canal') returning id`, [brand])
    const r = await updateAccount(id, { mode: 'auto' })
    assert.equal(r.ok, false)
    if (!r.ok) assert.match(r.error, /raman manuale/)
    assert.equal((await rows(db, `select mode from social_accounts where id = $1`, [id]))[0].mode, 'manual')
  })

  it('sync creates every channel; the YouTube one arrives as a manual account', async () => {
    assert.equal((await syncFakeAccounts(api)).status, 200)
    const accounts = await rows(db, `select platform, mode, status, paused, postiz_integration_id from social_accounts`)
    assert.equal(accounts.length, FAKE_INTEGRATIONS.length)
    for (const p of BATCH2) assert.ok(accounts.some((x) => x.platform === p), `${p} synced`)
    const youtube = accounts.find((x) => x.platform === 'youtube')!
    assert.deepEqual([youtube.mode, youtube.status, youtube.paused, youtube.postiz_integration_id], ['manual', 'manual', true, 'fake-youtube'])
    assert.ok(accounts.filter((x) => x.platform !== 'youtube').every((x) => x.mode === 'auto' && x.status === 'connected'))
    assert.equal((await syncFakeAccounts(api)).status, 200, 'a second sync keeps it manual')
    assert.equal((await rows(db, `select mode, status from social_accounts where platform = 'youtube'`))[0].mode, 'manual')
  })

  async function newPost(accountId: string, text: string, settings: Record<string, unknown>) {
    const [{ id }] = await rows(db, `select social_create_post($1::jsonb, $2::jsonb, $3::jsonb) as id`, [
      JSON.stringify({ brand_id: brand, kind: 'social', title: 'Titlu test', source_url: null, created_by: admin.userId }),
      JSON.stringify({ canonical_text: text, figures: [] }),
      JSON.stringify([{ account_id: accountId, text, settings, scheduled_at: null }]),
    ])
    return (await getPost(id))!
  }

  it('manual: a synced YouTube channel completes the handoff, with the needs-video notice', async () => {
    await syncFakeAccounts(api)
    const [{ id: account }] = await rows(db, `select id from social_accounts where platform = 'youtube'`)
    assert.equal((await updateAccount(account, { brand_id: brand, paused: false })).ok, true)
    const post = await newPost(account, 'Un ghid clar pentru documentele tale.', { title: 'Declaratia Unica, pas cu pas', tags: ['taxe', 'crypto'] })
    const approved = await approvePost({
      postId: post.id,
      revisionId: post.revision.id,
      times: Object.fromEntries(post.destinations.map((d) => [d.account_id, toLocalInputs(new Date())])),
      figuresChecked: false,
    })
    assert.equal(approved.ok, true, JSON.stringify(approved))
    await runFakeWorkerOnce(api, { scenario: 'ok' })
    const [job] = await rows(db, `select id, status from social_delivery_jobs`)
    assert.equal(job.status, 'manual_pending', 'the worker never gets a YouTube job')

    const handoff = await getManualJob(job.id)
    assert.ok(handoff)
    assert.match(handoff.handoff.notice ?? '', /video/)
    assert.deepEqual(handoff.handoff.fields.map((f) => [f.key, f.value]), [['title', 'Declaratia Unica, pas cu pas'], ['tags', 'taxe, crypto']])
    const url = 'https://www.youtube.com/watch?v=abc123'
    assert.deepEqual(await markManualPublished(job.id, url), { ok: true, alreadyDone: false })
    assert.equal((await rows(db, `select status from social_posts where id = $1`, [post.id]))[0].status, 'published')
  })
})
