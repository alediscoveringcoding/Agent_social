import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { xProvider } from '../providers/x.ts'
import { linkedinProvider, linkedinPageProvider } from '../providers/linkedin.ts'
import { facebookProvider, instagramProvider } from '../providers/meta.ts'
import { tiktokProvider } from '../providers/tiktok.ts'
import { youtubeProvider } from '../providers/youtube.ts'
import { nativeProvider } from '../providers/index.ts'
import { NativeProviderError, NativeProcessingFailedError } from '../http.ts'
import type { NativeContext, NativePublication, NativePublishInput } from '../types.ts'

function fixture(responses: Array<unknown | Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const checkpoints: NativePublication[] = []
  const ctx: NativeContext = { now: () => new Date('2030-01-01T00:00:00Z'), readMedia: async () => new Uint8Array([1, 2, 3]),
    publicMediaUrl: async () => 'https://media.example.test/asset', checkpoint: async (publication) => { checkpoints.push(publication) },
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init }); assert.ok(responses.length, 'unexpected provider call')
      const next = responses.shift()
      return next instanceof Response ? next : Response.json(next)
    } }
  return { ctx, calls, checkpoints }
}
function post(platform: NativePublishInput['account']['platform']): NativePublishInput {
  return { jobId: 'example-job', attemptNo: 1, idempotencyKey: '3m3example2345', text: 'Continut aprobat', settings: {}, media: [], scheduledAt: '2030-01-01T00:00:00Z',
    account: { platform, remoteId: '123', displayName: 'Example', metadata: {}, credentials: { secrets: { accessToken: 'fake-access-token' } } } }
}
const video = { id: 'video', mime: 'video/mp4', bytes: 3, sha256: 'fixture', altText: 'Descriere', width: 1080, height: 1920, filename: 'video.mp4', durationSeconds: 20 }
const creator = { creator_username: 'example', creator_nickname: 'Example', privacy_level_options: ['SELF_ONLY'], max_video_post_duration_sec: 30, comment_disabled: false, duet_disabled: true, stitch_disabled: true }
const tt = (data: unknown) => ({ data, error: { code: 'ok' } })

describe('requested OAuth providers with injected HTTP only', () => {
  it('registers every requested platform and excludes the skipped providers', () => {
    for (const platform of ['instagram', 'facebook', 'x', 'linkedin', 'linkedin-page', 'bluesky', 'telegram', 'devto', 'tiktok', 'youtube']) assert.equal(nativeProvider(platform).platform, platform)
    for (const platform of ['wordpress', 'discord', 'mastodon']) assert.throws(() => nativeProvider(platform), /UNAVAILABLE/)
  })
  it('X uploads approved images and alt text before the final post', async () => {
    const f = fixture([{ data: { id: '99' } }, {}, { data: { id: '100' } }])
    const input = post('x'); input.media = [{ ...video, mime: 'image/jpeg', filename: 'image.jpg' }]
    assert.equal((await xProvider.publish(f.ctx, input)).remoteUrl, 'https://x.com/i/web/status/100')
    assert.equal(JSON.parse(String(f.calls[1].init.body)).metadata.alt_text.text, 'Descriere')
    assert.deepEqual(JSON.parse(String(f.calls[2].init.body)), { text: input.text, media: { media_ids: ['99'] } })
  })
  it('LinkedIn uses the authenticated member and obtains the post ID from the header', async () => {
    const f = fixture([{ sub: 'member-id', name: 'Example' }, new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:42' } })])
    const [account] = await linkedinProvider.connect(f.ctx, { credentials: post('linkedin').account.credentials })
    await linkedinProvider.publish(f.ctx, { ...post('linkedin'), account })
    assert.equal(JSON.parse(String(f.calls[1].init.body)).author, 'urn:li:person:member-id')
    assert.match(new Headers(f.calls[1].init.headers).get('LinkedIn-Version')!, /^20\d{4}$/)
  })
  it('LinkedIn Pages lists only approved roles which can publish', async () => {
    const f = fixture([{ elements: [{ organization: 'urn:li:organization:7', role: 'ADMINISTRATOR', state: 'APPROVED' }, { organization: 'urn:li:organization:8', role: 'ANALYST', state: 'APPROVED' }] }, { localizedName: 'Example Page', vanityName: 'example-page' }])
    const accounts = await linkedinPageProvider.connect(f.ctx, { credentials: post('linkedin-page').account.credentials })
    assert.deepEqual(accounts.map((account) => account.remoteId), ['7'])
  })
  it('Facebook chooses a Page token and publishes staged image IDs in one feed write', async () => {
    process.env.META_GRAPH_VERSION = 'v25.0'
    const f = fixture([{ data: [{ id: 'page', name: 'Example', access_token: 'page-specific-token', tasks: ['CREATE_CONTENT'] }] }, { id: 'photo' }, { id: 'page_post' }])
    const [account] = await facebookProvider.connect(f.ctx, { credentials: post('facebook').account.credentials })
    const input = { ...post('facebook'), account, media: [{ ...video, mime: 'image/jpeg', filename: 'photo.jpg' }] }
    await facebookProvider.publish(f.ctx, input)
    assert.equal(new Headers(f.calls[2].init.headers).get('authorization'), 'Bearer page-specific-token')
    assert.deepEqual(JSON.parse(String(f.calls[2].init.body)).attached_media, [{ media_fbid: 'photo' }])
    assert.equal((f.calls[1].init.body as FormData).get('published'), 'false')
  })
  it('Instagram creates and checks an unpublished container before publishing once', async () => {
    process.env.META_GRAPH_VERSION = 'v25.0'
    const f = fixture([{ id: 'container' }, { status_code: 'FINISHED' }, { id: 'published' }, { permalink: 'https://www.instagram.com/p/example/' }])
    const input = post('instagram'); input.media = [{ ...video, mime: 'image/png', filename: 'image.png' }]
    let conversion: unknown
    f.ctx.publicMediaUrl = async (_media, options) => { conversion = options; return 'https://media.example.test/image.jpg' }
    const result = await instagramProvider.publish(f.ctx, input)
    assert.deepEqual(conversion, { jpeg: true })
    assert.equal(result.remoteId, 'published')
    assert.equal(f.calls.filter((call) => call.url.endsWith('/media_publish')).length, 1)
  })
  it('YouTube persists its private resumable session before uploading and waits for processing', async () => {
    const f = fixture([{ items: [{ id: '123' }] }, new Response(null, { headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fake-secret' } }), { id: 'youtube-id' }, { items: [{ id: 'youtube-id', processingDetails: { processingStatus: 'succeeded' } }] }])
    const input = post('youtube'); input.media = [video]; input.settings = { title: 'Titlu', privacy_status: 'private', made_for_kids: 'false' }
    const published = await youtubeProvider.publish(f.ctx, input)
    assert.equal(published.status, 'processing')
    assert.match(f.checkpoints[0].privateData!.sessionUrl, /fake-secret/)
    assert.equal(JSON.parse(String(f.calls[1].init.body)).status.privacyStatus, 'private')
    assert.equal((await youtubeProvider.poll!(f.ctx, input.account, published)).status, 'published')
  })
  it('YouTube recovers a lost final answer by probing the same upload session', async () => {
    const f = fixture([{ id: 'recovered-id' }])
    const result = await youtubeProvider.poll!(f.ctx, post('youtube').account, { remoteId: 'upload:job', status: 'processing', metadata: { phase: 'upload', bytes: 3 }, privateData: { sessionUrl: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fake' } })
    assert.equal(result.remoteId, 'recovered-id')
    assert.equal(new Headers(f.calls[0].init.headers).get('content-range'), 'bytes */3')
    assert.equal(f.calls[0].init.body, undefined)
  })
  it('TikTok checks current creator limits, checkpoints the publish ID and uploads bytes', async () => {
    const f = fixture([tt(creator), tt({ publish_id: 'publish-id', upload_url: 'https://open-upload.tiktokapis.com/video/?upload_token=fake' }), new Response(null, { status: 201 }), tt({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['1234567890123456789'] })])
    const input = post('tiktok'); input.media = [video]; input.account.metadata.username = 'example'
    input.settings = { privacy_level: 'SELF_ONLY', publish_consent: 'yes', commercial_content: 'NONE' }
    const publication = await tiktokProvider.publish(f.ctx, input)
    assert.equal(publication.status, 'processing')
    assert.equal(f.checkpoints[0].remoteId, 'publish-id')
    assert.equal(new Headers(f.calls[2].init.headers).get('content-range'), 'bytes 0-2/3')
    const result = await tiktokProvider.poll!(f.ctx, input.account, publication)
    assert.equal(result.status, 'published')
    assert.match(result.remoteUrl!, /1234567890123456789$/)
  })
  it('TikTok refuses missing consent, unavailable privacy and an oversized duration before creating a post', async () => {
    const cases: NativePublishInput['settings'][] = [{ privacy_level: 'SELF_ONLY' }, { privacy_level: 'PUBLIC_TO_EVERYONE', publish_consent: 'yes' }, { privacy_level: 'SELF_ONLY', publish_consent: 'yes' }]
    for (const settings of cases) {
      const f = fixture([tt(creator)])
      const input = post('tiktok'); input.media = [{ ...video, durationSeconds: 100 }]; input.settings = settings
      await assert.rejects(tiktokProvider.publish(f.ctx, input), NativeProviderError)
      assert.equal(f.calls.length, 1)
    }
  })
  it('distinguishes a failed status lookup from an explicit processing failure', async () => {
    const account = post('tiktok').account
    await assert.rejects(tiktokProvider.poll!(fixture([tt({ status: 'FAILED' })]).ctx, account, { remoteId: 'publish-id', status: 'processing' }), NativeProcessingFailedError)
    await assert.rejects(tiktokProvider.poll!(fixture([new Response(null, { status: 403 })]).ctx, account, { remoteId: 'publish-id', status: 'processing' }), (error: unknown) => error instanceof NativeProviderError && !(error instanceof NativeProcessingFailedError))
  })
})
