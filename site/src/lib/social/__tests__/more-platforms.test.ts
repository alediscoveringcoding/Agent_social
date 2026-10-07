/**
 * Amendment 04: threads, bluesky, mastodon, linkedin (profile), reddit,
 * pinterest, telegram, discord, medium, farcaster, nostr and lemmy.
 *
 * Tables and limits first (pure), then the drafts the fake generator makes,
 * then migration 0008 on PGlite, then two flows end to end: an automatic
 * platform (draft -> approval -> fake worker -> published) and a platform
 * switched to manual mode (draft -> approval -> manual handoff -> published).
 */

import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import type { PGlite } from '@electric-sql/pglite'
import { migratedDb } from '../../testing/pglite-db.ts'
import { createFakeSupabase } from '../../testing/fake-supabase.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { setTestAdmin } from '../../testing/auth-shim.ts'
import { routeFetch } from '../../testing/route-fetch.ts'
import { adminUser, brandId, createAccount, resetSocial, rows } from '../../testing/social-fixtures.ts'
import {
  CARD_FORMATS,
  DEFAULT_OPEN_EDITOR_URLS,
  MANUAL_ONLY_PLATFORMS,
  PLATFORMS,
  PLATFORM_CARD_FORMAT,
  PLATFORM_KIND,
  PLATFORM_LABELS,
  PROVIDER_TO_PLATFORM,
  type Platform,
} from '../constants.ts'
import { findDiacritics } from '../content-rules.ts'
import { buildDraftRevision, SETTINGS_KEYS, sanitizeSettings } from '../draft-edit.ts'
import { mapDraft } from '../draft-mapping.ts'
import { buildHandoff } from '../handoff.ts'
import { SETTINGS_FIELDS, settingsFieldKeys, settingsSummary } from '../platform-settings.ts'
import { DraftSchema } from '../schemas.ts'
import { platformForProvider } from '../sync-rules.ts'
import { graphemeLength, mastodonLength, measurePlatformLength, utf8Length } from '../text-length.ts'
import { measureLength, validateDestination, maxLengthFor, type ValidateDestinationInput } from '../validation.ts'
import { DRAFT_FIXTURES } from '../fake/fixtures.ts'
import { runFakeGeneratorOnce } from '../fake/fake-generator.ts'
import { runFakeWorkerOnce } from '../fake/fake-worker.ts'
import { WorkerApi } from '../fake/worker-api-client.ts'
import { approvePost } from '../approval-actions.ts'
import { getPost } from '../approval-queries.ts'
import { createManualAccount, updateAccount } from '../accounts-actions.ts'
import { markManualPublished } from '../handoff-actions.ts'
import { getManualJob } from '../handoff-queries.ts'
import { toLocalInputs } from '../time.ts'

const NEW_PLATFORMS = ['threads', 'bluesky', 'mastodon', 'linkedin', 'reddit', 'pinterest', 'telegram', 'discord', 'medium', 'farcaster', 'nostr', 'lemmy'] as const satisfies readonly Platform[]
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

describe('platform tables (amendment 04)', () => {
  it('lists 44 platforms; the 12 of the first batch have a Romanian label without diacritics, a kind and a card format', () => {
    assert.equal(PLATFORMS.length, 44)
    for (const p of NEW_PLATFORMS) assert.ok((PLATFORMS as readonly string[]).includes(p), p)
    const labels = PLATFORMS.map((p) => PLATFORM_LABELS[p])
    assert.equal(new Set(labels).size, PLATFORMS.length, 'labels are unique')
    for (const p of PLATFORMS) {
      assert.deepEqual(findDiacritics(PLATFORM_LABELS[p]), [], p)
      assert.ok(PLATFORM_KIND[p], p)
      assert.ok(PLATFORM_CARD_FORMAT[p] in CARD_FORMATS, `${p} card format`)
      if ((NEW_PLATFORMS as readonly string[]).includes(p)) assert.match(DEFAULT_OPEN_EDITOR_URLS[p] ?? '', /^https:\/\//, `${p} open-editor URL`)
    }
    assert.equal(PLATFORM_LABELS['linkedin-page'], 'LinkedIn (pagina)')
    assert.equal(PLATFORM_LABELS.linkedin, 'LinkedIn (profil)')
    assert.equal(PLATFORM_KIND.medium, 'article')
    for (const p of NEW_PLATFORMS) if (p !== 'medium') assert.equal(PLATFORM_KIND[p], 'social', p)
  })

  it('Pinterest has its own 1000x1500 card format; the others keep theirs', () => {
    assert.deepEqual(CARD_FORMATS.pinterest, { width: 1000, height: 1500 })
    assert.equal(PLATFORM_CARD_FORMAT.pinterest, 'pinterest')
    assert.equal(PLATFORM_CARD_FORMAT.instagram, 'portrait')
    assert.equal(PLATFORM_CARD_FORMAT.medium, 'hashnode_cover')
  })

  it('the first twelve are all automatic: only Substack, Product Hunt and (second batch) YouTube are manual-only', () => {
    assert.deepEqual([...MANUAL_ONLY_PLATFORMS].slice(0, 3), ['substack', 'producthunt', 'youtube'])
    for (const p of NEW_PLATFORMS) assert.ok(!MANUAL_ONLY_PLATFORMS.includes(p), p)
  })

  it('maps every Postiz identifier of the new platforms (v2.25.0) to our platform', () => {
    const expected: Record<string, Platform> = {
      threads: 'threads', bluesky: 'bluesky', mastodon: 'mastodon', 'mastodon-custom': 'mastodon', linkedin: 'linkedin', reddit: 'reddit',
      pinterest: 'pinterest', telegram: 'telegram', discord: 'discord', medium: 'medium', wrapcast: 'farcaster', nostr: 'nostr', lemmy: 'lemmy',
    }
    for (const [identifier, platform] of Object.entries(expected)) assert.equal(platformForProvider(identifier), platform, identifier)
    assert.equal(platformForProvider('LinkedIn'), 'linkedin', 'case is ignored')
    assert.equal(platformForProvider('linkedin-page'), 'linkedin-page', 'the page provider stays the page')
    assert.equal(platformForProvider('tiktok-ads'), null, 'an unknown provider is ignored at sync')
    for (const p of PLATFORMS) {
      if (MANUAL_ONLY_PLATFORMS.includes(p)) continue
      assert.ok(Object.values(PROVIDER_TO_PLATFORM).includes(p), `${p} has a Postiz identifier`)
    }
  })

  it('the OpenAPI contract lists the same platforms, in the same order', async () => {
    const yaml = await readFile(new URL('../../../../../docs/contracts/worker-api.openapi.yaml', import.meta.url), 'utf8')
    const m = yaml.match(/\n    Platform:\n      type: string\n      enum: \[([^\]]+)\]/)
    assert.ok(m, 'Platform enum found')
    assert.deepEqual(m[1].split(',').map((s) => s.trim()), [...PLATFORMS])
    for (const p of NEW_PLATFORMS) assert.ok(yaml.includes(`| ${p}`) || yaml.includes(p), p)
  })

  it('the settings table, the sanitizer keys and the editor fields agree', () => {
    for (const p of PLATFORMS) {
      for (const key of settingsFieldKeys(p)) assert.ok(SETTINGS_KEYS[p].includes(key), `${p}.${key} is not kept by the sanitizer`)
    }
    for (const p of ['discord', 'farcaster', 'lemmy', 'medium', 'pinterest', 'reddit']) assert.ok(p in SETTINGS_FIELDS, p)
    assert.deepEqual(sanitizeSettings('reddit', { subreddit: 'r/x', title: 'T', post_type: 'link', link_url: 'https://thecrypto.support/x', flair_id: 'f', evil: 'drop', who_can_reply: 'everyone' }), {
      subreddit: 'r/x', title: 'T', post_type: 'link', link_url: 'https://thecrypto.support/x', flair_id: 'f',
    })
    assert.deepEqual(sanitizeSettings('medium', { title: 'T', subtitle: 'S', canonical_url: OURS, tags: 'a, b,,c' }), { title: 'T', subtitle: 'S', canonical_url: OURS, tags: ['a', 'b', 'c'] })
    assert.deepEqual(sanitizeSettings('bluesky', { title: 'T' }), {})
    assert.deepEqual(settingsSummary('reddit', { subreddit: 'r/x', title: 'T', post_type: 'media' }), [
      { label: 'Subreddit', value: 'r/x' },
      { label: 'Tip postare', value: 'Imagine' },
    ])
  })
})

describe('how each platform counts text', () => {
  it('Bluesky counts graphemes, Mastodon counts a link as 23, Farcaster counts UTF-8 bytes', () => {
    assert.equal(graphemeLength('👨‍👩‍👧‍👦'), 1)
    assert.equal(measurePlatformLength('bluesky', '👨‍👩‍👧‍👦'.repeat(3)), 3)
    assert.equal(utf8Length('é'), 2)
    assert.equal(measurePlatformLength('farcaster', 'é'.repeat(10)), 20)
    assert.equal(mastodonLength(`Ghid: ${OURS}/${a(200)}`), 6 + 23)
    assert.equal(mastodonLength(`Ghid: ${OURS}.`), 6 + 23 + 1, 'trailing punctuation is text')
    assert.equal(measurePlatformLength('x', `Ghid ${OURS}`), 5 + 23)
    assert.equal(measureLength('threads', '👍'), 1)
    assert.equal(measurePlatformLength('linkedin', 'abc'), 3)
  })
})

describe('validation per new platform', () => {
  it('a plain post passes on every platform that needs no other field', () => {
    for (const p of ['threads', 'bluesky', 'mastodon', 'linkedin', 'telegram', 'farcaster', 'nostr'] as const) {
      const v = check(p)
      assert.equal(v.ok, true, `${p}: ${JSON.stringify(v.errors)}`)
    }
  })

  it('Threads: 500 characters, 20 images, one topic tag', () => {
    assert.equal(check('threads', { text: a(500) }).ok, true)
    assert.deepEqual(codes(check('threads', { text: a(501) })), ['TOO_LONG'])
    assert.equal(check('threads', { media: images(20) }).ok, true)
    assert.deepEqual(codes(check('threads', { media: images(21) })), ['TOO_MANY_IMAGES'])
    assert.deepEqual(warns(check('threads', { text: 'Salut #taxe #crypto' })), ['THREADS_HASHTAGS'])
    assert.deepEqual(warns(check('threads', { text: 'Salut #taxe' })), [])
  })

  it('Bluesky: 300 graphemes and 3,000 bytes, 4 images', () => {
    assert.equal(check('bluesky', { text: a(300) }).ok, true)
    assert.deepEqual(codes(check('bluesky', { text: a(301) })), ['TOO_LONG'])
    const family = '👨‍👩‍👧‍👦'.repeat(300)
    const v = check('bluesky', { text: family })
    assert.equal(v.length, 300)
    assert.deepEqual(codes(v), ['TOO_LONG_BYTES'], '300 graphemes pass, 7,500 bytes do not')
    assert.match(v.errors[0].message, /octeti/)
    assert.equal(check('bluesky', { media: images(4) }).ok, true)
    assert.deepEqual(codes(check('bluesky', { media: images(5) })), ['TOO_MANY_IMAGES'])
  })

  it('Mastodon: 500 characters with a link as 23, 4 images, alt text up to 1,500', () => {
    assert.equal(check('mastodon', { text: `${a(476)} ${OURS}/${a(100)}` }).ok, true)
    const over = check('mastodon', { text: `${a(478)} ${OURS}/${a(100)}` })
    assert.deepEqual(codes(over), ['TOO_LONG'])
    assert.match(over.errors[0].message, /un link = 23/)
    assert.deepEqual(codes(check('mastodon', { media: images(5) })), ['TOO_MANY_IMAGES'])
    assert.equal(check('mastodon', { media: [image(1600, 900, a(1500))] }).ok, true)
    assert.deepEqual(codes(check('mastodon', { media: [image(1600, 900, a(1501))] })), ['ALT_TEXT_TOO_LONG'])
  })

  it('LinkedIn profile: 3,000 characters and 9 images, like the page', () => {
    assert.equal(check('linkedin', { text: a(3000) }).ok, true)
    assert.deepEqual(codes(check('linkedin', { text: a(3001) })), ['TOO_LONG'])
    assert.deepEqual(codes(check('linkedin', { media: images(10) })), ['TOO_MANY_IMAGES'])
  })

  it('Reddit: subreddit and title are required, the type decides the rest', () => {
    const ok = { subreddit: 'r/taxes_ro', title: 'Un titlu clar', post_type: 'self' }
    assert.equal(check('reddit', { settings: ok }).ok, true)
    assert.deepEqual(codes(check('reddit')), ['REDDIT_SUBREDDIT_MISSING', 'REDDIT_TITLE_MISSING'])
    assert.deepEqual(codes(check('reddit', { settings: { ...ok, subreddit: 'x' } })), ['REDDIT_SUBREDDIT_INVALID'])
    assert.deepEqual(codes(check('reddit', { settings: { ...ok, subreddit: 'r/doua cuvinte' } })), ['REDDIT_SUBREDDIT_INVALID'])
    assert.equal(check('reddit', { settings: { ...ok, subreddit: 'taxes_ro' } }).ok, true, 'r/ is optional')
    assert.equal(check('reddit', { settings: { ...ok, title: a(300) } }).ok, true)
    assert.deepEqual(codes(check('reddit', { settings: { ...ok, title: a(301) } })), ['REDDIT_TITLE_TOO_LONG'])
    assert.deepEqual(codes(check('reddit', { text: a(10001), settings: ok })), ['TOO_LONG'])
    assert.deepEqual(codes(check('reddit', { settings: { ...ok, post_type: 'poll' } })), ['REDDIT_TYPE_INVALID'])
    // link posts
    assert.deepEqual(codes(check('reddit', { settings: { ...ok, post_type: 'link' } })), ['REDDIT_LINK_MISSING'])
    assert.deepEqual(codes(check('reddit', { settings: { ...ok, post_type: 'link', link_url: 'ftp://x.test/a' } })), ['REDDIT_LINK_INVALID'])
    assert.equal(check('reddit', { settings: { ...ok, post_type: 'link', link_url: OURS } }).ok, true)
    // media posts hold exactly one image; other types ignore images
    assert.deepEqual(codes(check('reddit', { settings: { ...ok, post_type: 'media' } })), ['REDDIT_MEDIA_COUNT'])
    assert.equal(check('reddit', { settings: { ...ok, post_type: 'media' }, media: images(1) }).ok, true)
    assert.deepEqual(codes(check('reddit', { settings: { ...ok, post_type: 'media' }, media: images(2) })), ['REDDIT_MEDIA_COUNT', 'TOO_MANY_IMAGES'])
    assert.deepEqual(warns(check('reddit', { settings: ok, media: images(1) })), ['REDDIT_IMAGE_IGNORED'])
  })

  it('Pinterest: image, board id, title, link; 500-character description; 1000x1500 recommended', () => {
    const ok = { board: '549755885175', title: 'Declaratia Unica pe scurt', link: OURS }
    const pin = [image(1000, 1500)]
    const v = check('pinterest', { settings: ok, media: pin })
    assert.equal(v.ok, true, JSON.stringify(v.errors))
    assert.deepEqual(v.warnings, [])
    assert.deepEqual(codes(check('pinterest', { settings: ok })), ['PIN_NO_IMAGE'])
    assert.deepEqual(codes(check('pinterest', { media: pin })), ['PIN_BOARD_MISSING', 'PIN_LINK_MISSING', 'PIN_TITLE_MISSING'])
    assert.deepEqual(codes(check('pinterest', { settings: { ...ok, board: 'Taxe' }, media: pin })), ['PIN_BOARD_INVALID'])
    assert.equal(check('pinterest', { settings: { ...ok, title: a(100) }, media: pin }).ok, true)
    assert.deepEqual(codes(check('pinterest', { settings: { ...ok, title: a(101) }, media: pin })), ['PIN_TITLE_TOO_LONG'])
    assert.deepEqual(codes(check('pinterest', { settings: { ...ok, link: 'nu e link' }, media: pin })), ['PIN_LINK_INVALID'])
    assert.deepEqual(codes(check('pinterest', { settings: { ...ok, link: `${OURS}/${a(2050)}` }, media: pin })), ['PIN_LINK_INVALID'])
    assert.equal(check('pinterest', { text: a(500), settings: ok, media: pin }).ok, true)
    assert.deepEqual(codes(check('pinterest', { text: a(501), settings: ok, media: pin })), ['TOO_LONG'])
    assert.deepEqual(codes(check('pinterest', { settings: ok, media: Array.from({ length: 6 }, () => image(1000, 1500)) })), ['TOO_MANY_IMAGES'])
    assert.deepEqual(warns(check('pinterest', { settings: ok, media: [image(1080, 1080)] })), ['COVER_SIZE'])
    assert.deepEqual(codes(check('pinterest', { settings: ok, media: [image(1000, 1500, a(501))] })), ['ALT_TEXT_TOO_LONG'])
  })

  it('Telegram: 4,096 characters, 1,024 when an image makes the text its caption, 10 images', () => {
    assert.equal(check('telegram', { text: a(4096) }).ok, true)
    assert.deepEqual(codes(check('telegram', { text: a(4097) })), ['TOO_LONG'])
    const withImage = check('telegram', { text: a(1025), media: images(1) })
    assert.deepEqual(codes(withImage), ['TOO_LONG'])
    assert.equal(withImage.maxLength, 1024)
    assert.match(withImage.errors[0].message, /imagine/)
    assert.equal(check('telegram', { text: a(1024), media: images(1) }).ok, true)
    assert.equal(maxLengthFor('telegram', null, 0), 4096)
    assert.equal(maxLengthFor('telegram', null, 2), 1024)
    assert.deepEqual(codes(check('telegram', { media: images(11) })), ['TOO_MANY_IMAGES'])
  })

  it('Discord: a numeric channel id, 1,980 characters, 10 images', () => {
    assert.equal(check('discord', { settings: { channel: '123456789012345678' } }).ok, true)
    assert.deepEqual(codes(check('discord')), ['DISCORD_CHANNEL_MISSING'])
    assert.deepEqual(codes(check('discord', { settings: { channel: 'general' } })), ['DISCORD_CHANNEL_INVALID'])
    assert.equal(check('discord', { text: a(1980), settings: { channel: '123456789012345678' } }).ok, true)
    assert.deepEqual(codes(check('discord', { text: a(1981), settings: { channel: '123456789012345678' } })), ['TOO_LONG'])
    assert.deepEqual(codes(check('discord', { settings: { channel: '123456789012345678' }, media: images(11) })), ['TOO_MANY_IMAGES'])
  })

  it('Medium: title, subtitle, canonical link to our blog, at most 3 tags of 25 characters', () => {
    const ok = { title: 'Cum calculezi impozitul', subtitle: 'Pas cu pas', canonical_url: OURS, tags: ['crypto', 'taxe', 'romania'] }
    const v = check('medium', { settings: ok })
    assert.equal(v.ok, true, JSON.stringify(v.errors))
    assert.deepEqual(codes(check('medium')), ['CANONICAL_MISSING', 'MEDIUM_SUBTITLE_MISSING', 'TITLE_MISSING'])
    assert.deepEqual(codes(check('medium', { settings: { ...ok, tags: ['a', 'b', 'c', 'd'] } })), ['TOO_MANY_TAGS'])
    assert.deepEqual(codes(check('medium', { settings: { ...ok, tags: [a(26)] } })), ['TAG_TOO_LONG'])
    assert.deepEqual(codes(check('medium', { settings: { ...ok, canonical_url: 'https://example.test/x' } })), ['CANONICAL_NOT_OURS'])
    assert.deepEqual(codes(check('medium', { settings: { ...ok, subtitle: '' } })), ['MEDIUM_SUBTITLE_MISSING'])
    assert.deepEqual(warns(check('medium', { settings: ok, media: images(1) })), ['MEDIUM_NO_COVER'])
    assert.equal(check('medium', { text: a(100000), settings: ok }).ok, true)
  })

  it('Farcaster: 320 bytes, 2 images, an optional channel', () => {
    assert.equal(check('farcaster', { text: a(320) }).ok, true)
    const long = check('farcaster', { text: a(321) })
    assert.deepEqual(codes(long), ['TOO_LONG'])
    assert.match(long.errors[0].message, /octeti/)
    assert.deepEqual(codes(check('farcaster', { text: 'é'.repeat(161) })), ['TOO_LONG'], '322 bytes')
    assert.equal(check('farcaster', { text: 'é'.repeat(160) }).ok, true, '320 bytes')
    assert.deepEqual(codes(check('farcaster', { media: images(3) })), ['TOO_MANY_IMAGES'])
    assert.equal(check('farcaster', { settings: { channel: 'founders' } }).ok, true)
    assert.deepEqual(codes(check('farcaster', { settings: { channel: 'Doua Cuvinte' } })), ['FARCASTER_CHANNEL_INVALID'])
  })

  it('Nostr: no practical limit below 100,000 characters', () => {
    assert.equal(check('nostr', { text: a(20000) }).ok, true)
    assert.deepEqual(codes(check('nostr', { text: a(100001) })), ['TOO_LONG'])
  })

  it('Lemmy: community name and numeric id, a 3 to 200 character title, one image', () => {
    const ok = { community: 'taxes', community_id: '42', title: 'Declaratia Unica: termenul' }
    assert.equal(check('lemmy', { settings: ok }).ok, true)
    assert.deepEqual(codes(check('lemmy')), ['LEMMY_COMMUNITY_ID_MISSING', 'LEMMY_COMMUNITY_MISSING', 'LEMMY_TITLE_MISSING'])
    assert.deepEqual(codes(check('lemmy', { settings: { ...ok, community: 'taxes@lemmy.world' } })), ['LEMMY_COMMUNITY_INVALID'])
    assert.deepEqual(codes(check('lemmy', { settings: { ...ok, community_id: 'abc' } })), ['LEMMY_COMMUNITY_ID_INVALID'])
    assert.deepEqual(codes(check('lemmy', { settings: { ...ok, title: 'ab' } })), ['LEMMY_TITLE_LENGTH'])
    assert.equal(check('lemmy', { settings: { ...ok, title: a(200) } }).ok, true)
    assert.deepEqual(codes(check('lemmy', { settings: { ...ok, title: a(201) } })), ['LEMMY_TITLE_LENGTH'])
    assert.deepEqual(codes(check('lemmy', { settings: { ...ok, title: 'doua\nrandari' } })), ['LEMMY_TITLE_LENGTH'])
    assert.deepEqual(codes(check('lemmy', { settings: { ...ok, link: 'nu e link' } })), ['LEMMY_LINK_INVALID'])
    assert.equal(check('lemmy', { settings: { ...ok, link: OURS } }).ok, true)
    assert.deepEqual(codes(check('lemmy', { text: a(10001), settings: ok })), ['TOO_LONG'])
    assert.deepEqual(codes(check('lemmy', { settings: ok, media: images(2) })), ['TOO_MANY_IMAGES'])
  })

  it('every platform keeps the shared hard checks (diacritics in a title, empty text)', () => {
    assert.ok(codes(check('reddit', { settings: { subreddit: 'r/taxes_ro', title: 'Știai că?' } })).includes('DIACRITICS'))
    assert.ok(codes(check('lemmy', { text: '  ', settings: { community: 'taxes', community_id: '1', title: 'Titlu' } })).includes('EMPTY_TEXT'))
  })
})

describe('drafts from the generator reach the new platforms', () => {
  const fixture = (name: string) => {
    const { name: _name, ...draft } = DRAFT_FIXTURES.find((f) => f.name === name)!
    return DraftSchema.parse({ ...draft, client_ref: name })
  }
  const accounts = NEW_PLATFORMS.map((platform) => ({ id: `acc-${platform}`, platform, display_name: platform }))

  it('the fixture covers 11 new platforms and is a valid draft', () => {
    const draft = fixture('more-platforms')
    assert.deepEqual(draft.variants.map((v) => v.platform).sort(), NEW_PLATFORMS.filter((p) => p !== 'medium').sort())
    assert.ok(DRAFT_FIXTURES.find((f) => f.name === 'article')!.variants.some((v) => v.platform === 'medium'))
  })

  it('maps a destination per account, with the settings each platform needs and its own blockers', () => {
    const mapped = mapDraft(fixture('more-platforms'), accounts, { now: NOW })
    assert.equal(mapped.destinations.length, 11)
    const by = (p: string) => mapped.destinations.find((d) => d.platform === p)!
    assert.deepEqual(by('reddit').settings, { post_type: 'self', title: 'Declaratia Unica: termenul este 25 mai, iata pasii pentru crypto' })
    assert.deepEqual(by('pinterest').settings, { title: 'Declaratia Unica: termen 25 mai', link: 'https://thecrypto.support/ghid/declaratia-unica' })
    assert.deepEqual(by('lemmy').settings, { title: 'Declaratia Unica: termenul este 25 mai' })
    const blockers = (p: string) => by(p).validation.errors.map((e) => e.code).sort()
    for (const p of ['threads', 'bluesky', 'mastodon', 'linkedin', 'telegram', 'farcaster', 'nostr']) assert.deepEqual(blockers(p), [], p)
    assert.deepEqual(blockers('reddit'), ['REDDIT_SUBREDDIT_MISSING'])
    assert.deepEqual(blockers('pinterest'), ['PIN_BOARD_MISSING', 'PIN_NO_IMAGE'])
    assert.deepEqual(blockers('discord'), ['DISCORD_CHANNEL_MISSING'])
    assert.deepEqual(blockers('lemmy'), ['LEMMY_COMMUNITY_ID_MISSING', 'LEMMY_COMMUNITY_MISSING'])
  })

  it('a Medium destination takes the article: title, subtitle, tags, canonical link and body', () => {
    const mapped = mapDraft(fixture('article'), accounts.filter((a) => a.platform === 'medium'), { now: NOW })
    const [d] = mapped.destinations
    assert.equal(d.platform, 'medium')
    assert.deepEqual(d.settings, { title: 'Cum calculezi impozitul pe crypto', subtitle: 'Pas cu pas, fara surprize', tags: ['crypto', 'taxe', 'romania'], canonical_url: 'https://thecrypto.support/ghid/impozit-crypto' })
    assert.match(d.text, /^# Cum calculezi impozitul pe crypto/)
    assert.deepEqual(d.validation.errors, [])
  })

  it('saving an edit keeps the new keys and validates them', () => {
    const base = {
      kind: 'social' as const, title: null, figures: [], body_markdown: null, article: null, launch: null, card_spec: null, variants: [], notes: null, generator_errors: [],
      destinations: [{ account_id: 'acc-reddit', media: [] }],
    }
    const rev = buildDraftRevision(
      base,
      { canonicalText: TEXT, figures: [], destinations: [{ accountId: 'acc-reddit', text: TEXT, settings: { subreddit: 'r/taxes_ro', title: 'Titlu', post_type: 'self', bogus: 'x' } }] },
      [{ id: 'acc-reddit', platform: 'reddit' }],
      { actorEmail: 'admin@example.test', now: NOW }
    )
    assert.deepEqual(rev.destinations[0].settings, { subreddit: 'r/taxes_ro', title: 'Titlu', post_type: 'self' })
    assert.deepEqual(rev.destinations[0].validation.errors, [])
  })
})

describe('manual handoff fields and checklists for the new platforms', () => {
  it('every platform has a checklist, and the platform-specific fields show', () => {
    for (const platform of PLATFORMS) {
      const h = buildHandoff({ platform, kind: PLATFORM_KIND[platform], title: 'Titlu', text: TEXT, settings: {} })
      assert.ok(h.checklist.length >= 2, `${platform} checklist`)
    }
    const reddit = buildHandoff({ platform: 'reddit', kind: 'social', title: null, text: TEXT, settings: { subreddit: 'r/taxes_ro', title: 'Un titlu', post_type: 'link', link_url: OURS } })
    assert.deepEqual(reddit.fields.map((f) => [f.key, f.value]), [['subreddit', 'r/taxes_ro'], ['title', 'Un titlu'], ['post_type', 'Link'], ['link_url', OURS]])
    assert.equal(reddit.fields.find((f) => f.key === 'title')!.max, 300)
    assert.match(reddit.checklist.join(' '), /Subreddit/)
    const pin = buildHandoff({ platform: 'pinterest', kind: 'social', title: null, text: 'Descriere', settings: { board: '1', title: 'Pin', link: OURS } })
    assert.deepEqual(pin.fields.map((f) => f.key), ['board', 'title', 'link'])
    assert.match(pin.checklist.join(' '), /1000x1500/)
    const lemmy = buildHandoff({ platform: 'lemmy', kind: 'social', title: null, text: TEXT, settings: { community: 'taxes', community_id: '5', title: 'Titlu' } })
    assert.deepEqual(lemmy.fields.map((f) => f.key), ['community', 'community_id', 'title'])
    const medium = buildHandoff({ platform: 'medium', kind: 'article', title: 'Titlu', text: '# Articol\n\nUn **ghid**.', settings: { title: 'Titlu', subtitle: 'Sub', tags: ['a', 'b'], canonical_url: OURS } })
    assert.deepEqual(medium.fields.map((f) => f.key), ['title', 'subtitle', 'tags', 'canonical_url'])
    assert.match(medium.body.html, /<strong>ghid<\/strong>/)
    const bluesky = buildHandoff({ platform: 'bluesky', kind: 'social', title: null, text: TEXT, settings: {} })
    assert.deepEqual(bluesky.fields, [])
    assert.equal(bluesky.body.plain, TEXT)
  })
})

const TOKEN = 'more-platforms-token-0123456789abcdef'
let db: PGlite
let brand: string
let admin: { userId: string; email: string }
let api: WorkerApi

describe('migration 0008 and the flows it enables', () => {
  before(async () => {
    db = await migratedDb()
    setTestAdminClient(createFakeSupabase(db))
    brand = await brandId(db)
    admin = { userId: await adminUser(db), email: 'admin@example.test' }
    api = new WorkerApi({ baseUrl: 'http://127.0.0.1:3000', token: TOKEN, workerId: 'more-platforms-worker', fetch: routeFetch })
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

  async function newPost(accountId: string, text: string, settings: Record<string, unknown>) {
    const [{ id }] = await rows(db, `select social_create_post($1::jsonb, $2::jsonb, $3::jsonb) as id`, [
      JSON.stringify({ brand_id: brand, kind: 'social', title: 'Titlu test', source_url: null, created_by: admin.userId }),
      JSON.stringify({ canonical_text: text, figures: [] }),
      JSON.stringify([{ account_id: accountId, text, settings, scheduled_at: null }]),
    ])
    return (await getPost(id))!
  }
  const approveNow = (post: NonNullable<Awaited<ReturnType<typeof getPost>>>, figuresChecked = false) =>
    approvePost({ postId: post.id, revisionId: post.revision.id, times: Object.fromEntries(post.destinations.map((d) => [d.account_id, toLocalInputs(new Date())])), figuresChecked })

  it('accepts the new platforms on accounts, destinations and manual accounts; refuses anything else', async () => {
    for (const platform of NEW_PLATFORMS) {
      const id = await createAccount(db, brand, platform)
      const post = await newPost(id, 'Un ghid clar pentru documentele tale.', {})
      assert.equal(post.destinations[0].platform, platform)
    }
    await assert.rejects(rows(db, `insert into social_accounts (platform, mode, status, display_name) values ('vimeo', 'manual', 'manual', 'video')`), /social_accounts_platform_allowed/)
    await assert.rejects(rows(db, `insert into social_accounts (platform, mode, status, display_name) values ('twitter', 'manual', 'manual', 'video')`), /social_accounts_platform_allowed/)
    for (const platform of NEW_PLATFORMS) {
      const r = await createManualAccount({ brandId: brand, displayName: `Manual ${platform}`, platform })
      assert.equal(r.ok, true, platform)
    }
    assert.equal((await createManualAccount({ brandId: brand, displayName: 'Video', platform: 'vimeo' as Platform })).ok, false)
  })

  it('keeps Substack and Product Hunt manual-only, and does not make a new platform manual-only', async () => {
    await assert.rejects(
      rows(db, `insert into social_accounts (platform, mode, status, postiz_integration_id, display_name) values ('substack', 'auto', 'connected', 'x-1', 'S')`),
      /SOCIAL_MANUAL_ONLY_PLATFORM/
    )
    const reddit = await createAccount(db, brand, 'reddit')
    assert.equal((await updateAccount(reddit, { mode: 'manual' })).ok, true, 'a new platform can be switched to manual mode')
    assert.equal((await updateAccount(reddit, { mode: 'auto' })).ok, true, 'and back, because it has a Postiz channel')
    const sub = await createAccount(db, brand, 'substack')
    assert.equal((await updateAccount(sub, { mode: 'auto' })).ok, false, 'Substack has no Postiz channel and stays manual')
  })

  it('has one platform list function, and the pinterest card format is allowed on media', async () => {
    const [{ n }] = await rows(db, `select cardinality(social_known_platforms()) as n`)
    assert.equal(Number(n), PLATFORMS.length)
    const names = (await rows(db, `select unnest(social_known_platforms()) as p`)).map((r) => r.p).sort()
    assert.deepEqual(names, [...PLATFORMS].sort())
    await rows(db, `insert into social_media(storage_path, sha256, mime, width, height, bytes, alt_text, source, format) values ('test/pin.png', repeat('b', 64), 'image/png', 1000, 1500, 100, 'Pin', 'generated', 'pinterest')`)
    await assert.rejects(
      rows(db, `insert into social_media(storage_path, sha256, mime, width, height, bytes, alt_text, source, format) values ('test/bad.png', repeat('c', 64), 'image/png', 1000, 1500, 100, 'Bad', 'generated', 'tiktok_cover')`),
      /social_media_format_allowed/
    )
    const old = await rows(db, `select conname from pg_constraint where conrelid in ('social_accounts'::regclass, 'social_destinations'::regclass) and pg_get_constraintdef(oid) like '%''threads''%'`)
    assert.deepEqual(old.map((r) => r.conname).sort(), [], 'the platform list lives in the function, not in a literal check')
  })

  it('automatic: a Bluesky draft goes from the fake generator through approval and the fake worker to published', async () => {
    const account = await createAccount(db, brand, 'bluesky')
    await rows(db, `insert into social_generation_requests (brand_id, input) values ($1, $2)`, [
      brand,
      JSON.stringify({ source: { type: 'topic', topic: 'Declaratia Unica' }, platforms: ['bluesky'], kinds: ['social'], count: 1, language: 'ro', templates: ['dark'] }),
    ])
    const [generated] = await runFakeGeneratorOnce(api)
    assert.equal(generated.status, 200, JSON.stringify(generated.body))
    const [{ id: postId }] = await rows(db, `select id from social_posts`)
    const post = (await getPost(postId))!
    assert.deepEqual(post.destinations.map((d) => [d.platform, d.account_id]), [['bluesky', account]])
    assert.match(post.destinations[0].text, /thecrypto\.support/)

    const approved = await approveNow(post, true)
    assert.equal(approved.ok, true, JSON.stringify(approved))
    const submitted = await runFakeWorkerOnce(api, { scenario: 'ok' })
    assert.ok(submitted.some((s) => s.action === 'submitted'), JSON.stringify(submitted))
    await db.query("update social_delivery_jobs set next_check_at = now() - interval '1 second'")
    const polled = await runFakeWorkerOnce(api, { scenario: 'ok' })
    assert.ok(polled.some((s) => s.action === 'poll -> published' && s.status === 200), JSON.stringify(polled))
    const done = (await getPost(postId))!
    assert.equal(done.status, 'published')
    assert.match(done.destinations[0].job!.remote_url!, /^https:\/\/example\.com\/fake\/bluesky\//)
  })

  it('a Reddit draft cannot be approved without a subreddit, and the missing field is named', async () => {
    const account = await createAccount(db, brand, 'reddit')
    const post = await newPost(account, 'Un ghid clar pentru documentele tale.', { title: 'Un titlu clar', post_type: 'self' })
    const refused = await approveNow(post)
    assert.equal(refused.ok, false)
    if (refused.ok) return
    assert.match(refused.error, /blocheaza/)
    assert.deepEqual(refused.issues?.flatMap((i) => i.errors.map((e) => e.code)), ['REDDIT_SUBREDDIT_MISSING'])
    assert.equal((await rows(db, `select 1 from social_delivery_jobs`)).length, 0)
  })

  it('manual: a Reddit account in manual mode completes the manual handoff with its own fields', async () => {
    const account = await createAccount(db, brand, 'reddit')
    assert.equal((await updateAccount(account, { mode: 'manual' })).ok, true)
    const post = await newPost(account, 'Un ghid clar pentru documentele tale.', { subreddit: 'r/taxes_ro', title: 'Un titlu clar', post_type: 'self' })
    const approved = await approveNow(post)
    assert.equal(approved.ok, true, JSON.stringify(approved))
    await runFakeWorkerOnce(api, { scenario: 'ok' })
    const [job] = await rows(db, `select id, status from social_delivery_jobs`)
    assert.equal(job.status, 'manual_pending')

    const handoff = await getManualJob(job.id)
    assert.ok(handoff)
    assert.deepEqual(handoff.handoff.fields.map((f) => [f.label, f.value]), [['Subreddit', 'r/taxes_ro'], ['Titlu', 'Un titlu clar'], ['Tip postare', 'Text']])
    assert.match(handoff.handoff.checklist.join(' '), /Subreddit/)
    assert.equal(handoff.handoff.body.plain, 'Un ghid clar pentru documentele tale.')
    assert.equal(handoff.account.open_editor_url ?? DEFAULT_OPEN_EDITOR_URLS.reddit, DEFAULT_OPEN_EDITOR_URLS.reddit)

    const url = 'https://www.reddit.com/r/taxes_ro/comments/abc123/un_titlu_clar/'
    assert.deepEqual(await markManualPublished(job.id, url), { ok: true, alreadyDone: false })
    assert.equal((await rows(db, `select status from social_posts where id = $1`, [post.id]))[0].status, 'published')
    assert.equal((await getManualJob(job.id))?.job.remote_url, url)
  })
})
