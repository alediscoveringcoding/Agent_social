import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mediumProvider } from '../providers/medium.ts'
import { hashnodeProvider } from '../providers/hashnode.ts'
import { slackProvider } from '../providers/slack.ts'
import { githubProvider } from '../providers/github.ts'
import { listmonkProvider } from '../providers/listmonk.ts'
import { stackexchangeProvider } from '../providers/stackexchange.ts'
import { farcasterProvider } from '../providers/farcaster.ts'
import { lemmyProvider } from '../providers/lemmy.ts'
import { NativeProviderError, NativeProcessingFailedError } from '../http.ts'
import { AUTOMATIC_API_PLATFORMS, EXCLUDED_NATIVE_PLATFORMS, INACTIVE_API_PLATFORMS, NOT_IMPLEMENTED_PLATFORMS, apiAvailability } from '../capabilities.ts'
import { REGISTERED_NATIVE_PLATFORMS, nativeProvider } from '../providers/index.ts'
import { DROPPED_PLATFORMS, PLATFORMS } from '../../social/constants.ts'
import { validateDestination } from '../../social/validation.ts'
import type { NativeContext, NativePublication, NativePublishInput } from '../types.ts'

function fixture(responses: unknown[]) {
  const calls: Array<{ url: string; init: RequestInit }> = []; const checkpoints: NativePublication[] = []; const events: string[] = []
  const ctx: NativeContext = { now: () => new Date('2030-01-01'), readMedia: async () => new Uint8Array([1, 2, 3]),
    publicMediaUrl: async () => 'https://media.example.test/approved.png',
    checkpoint: async publication => { events.push('checkpoint'); checkpoints.push(publication) },
    beforePublish: async () => { events.push('gate') },
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init }); events.push(String(url)); assert.ok(responses.length, 'Unexpected provider request')
      const next = responses.shift(); if (next instanceof Error) throw next
      return next instanceof Response ? next : Response.json(next)
    } }
  return { ctx, calls, checkpoints, events }
}
function post(platform: NativePublishInput['account']['platform']): NativePublishInput {
  return { jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', attemptNo: 1, idempotencyKey: '3m3example2345', text: 'Text aprobat pentru publicare.', settings: {}, media: [], scheduledAt: '2030-01-01T00:00:00Z',
    account: { platform, remoteId: '17', displayName: 'Example', metadata: {}, credentials: { secrets: { accessToken: 'fake-token', apiKey: 'fake-key' } } } }
}
const image = { id: 'image', mime: 'image/png', bytes: 3, sha256: 'fixture', altText: 'Imagine aprobata', width: 800, height: 600, filename: 'approved.png' }
const body = (f: ReturnType<typeof fixture>, index: number) => JSON.parse(String(f.calls[index].init.body))
const errorCode = (code: string, ambiguous: boolean) => (error: unknown) => error instanceof NativeProviderError && error.code === code && error.ambiguous === ambiguous

describe('automatic API connections and explicit inactive platform bin', () => {
  it('accounts for every platform and exposes only implemented adapters as automatic choices', () => {
    assert.deepEqual([...AUTOMATIC_API_PLATFORMS].sort(), [...REGISTERED_NATIVE_PLATFORMS].sort())
    const all = [...AUTOMATIC_API_PLATFORMS, ...INACTIVE_API_PLATFORMS, ...NOT_IMPLEMENTED_PLATFORMS, ...EXCLUDED_NATIVE_PLATFORMS]
    assert.equal(new Set(all).size, all.length)
    assert.deepEqual([...all].sort(), [...PLATFORMS].sort())
    for (const platform of AUTOMATIC_API_PLATFORMS) assert.equal(nativeProvider(platform).platform, platform)
    for (const platform of [...INACTIVE_API_PLATFORMS, ...NOT_IMPLEMENTED_PLATFORMS, ...EXCLUDED_NATIVE_PLATFORMS]) assert.throws(() => nativeProvider(platform), /UNAVAILABLE/)
    assert.equal(apiAvailability('medium').state, 'conditional'); assert.equal(apiAvailability('hashnode').state, 'conditional')
    assert.equal(apiAvailability('threads').state, 'dropped'); assert.match(apiAvailability('threads').reason, /Neimplementata/)
    assert.deepEqual([...NOT_IMPLEMENTED_PLATFORMS, ...EXCLUDED_NATIVE_PLATFORMS].sort(), [...DROPPED_PLATFORMS].sort(), 'the dropped list is the not implemented and the excluded platforms')
  })
  it('Medium verifies an existing token and publishes the approved article, canonical URL and attached image', async () => {
    const f = fixture([{ data: { id: 'user', name: 'Example', url: 'https://medium.com/@example' } }, { data: { url: 'https://cdn-images-1.medium.com/example.png' } }, { data: { id: 'article', url: 'https://medium.com/example/article' } }])
    const [account] = await mediumProvider.connect(f.ctx, { credentials: { secrets: { accessToken: 'fake-medium' } } })
    const input = post('medium'); input.account = account; input.settings = { title: 'Titlu', subtitle: 'Subtitlu', canonical_url: 'https://blog.example.test/article', tags: ['one', 'two', 'three'] }; input.media = [image]
    assert.equal((await mediumProvider.publish(f.ctx, input)).remoteId, 'article')
    assert.ok(f.calls[1].init.body instanceof FormData)
    const sent = body(f, 2)
    assert.equal(sent.publishStatus, 'public'); assert.equal(sent.canonicalUrl, input.settings.canonical_url)
    assert.equal(sent.content, '# Titlu\n\nSubtitlu\n\nText aprobat pentru publicare.\n\n![Imagine aprobata](https://cdn-images-1.medium.com/example.png)')
    assert.deepEqual(f.events.filter(event => event === 'gate'), ['gate'])
  })
  it('Hashnode uses the current endpoint, Bearer token, publication ID and string coverImage schema', async () => {
    const id = '0123456789abcdef01234567'
    const f = fixture([{ data: { me: { id: 'person' }, publication: { id, title: 'Example', url: 'https://blog.example.test' } } },
      { data: { createImageUploadURL: { presignedPut: { url: 'https://upload.example.test/presigned', key: 'images/example.png' } } } }, new Response(null, { status: 204 }),
      { data: { confirmImageUpload: { ok: true, cdnUrl: 'https://cdn.hashnode.com/example.png' } } }, { data: { publishPost: { post: { id: 'post', url: 'https://blog.example.test/post' } } } }])
    const [account] = await hashnodeProvider.connect(f.ctx, { credentials: { secrets: { accessToken: 'fake-hashnode' } }, destinationId: id })
    const input = post('hashnode'); input.account = account; input.settings = { title: 'Titlu', tags: ['typescript'], canonical_url: 'https://source.example.test/post' }; input.media = [image]
    assert.equal((await hashnodeProvider.publish(f.ctx, input)).status, 'published')
    assert.ok(f.calls.filter((_call, index) => index !== 2).every(call => call.url === 'https://gql-beta.hashnode.com'))
    assert.equal(f.calls[2].init.method, 'PUT'); assert.equal(new Headers(f.calls[2].init.headers).has('authorization'), false)
    assert.equal(new Headers(f.calls[0].init.headers).get('authorization'), 'Bearer fake-hashnode')
    assert.deepEqual(body(f, 4).variables.input, { publicationId: id, title: 'Titlu', contentMarkdown: input.text, tags: [{ slug: 'typescript', name: 'typescript' }], originalArticleURL: input.settings.canonical_url, coverImage: 'https://cdn.hashnode.com/example.png' })
  })
  it('a Hashnode Pro refusal is definitive; partial GraphQL write results remain uncertain', async () => {
    const input = post('hashnode'); input.settings.title = 'Titlu'
    await assert.rejects(hashnodeProvider.publish(fixture([{ errors: [{ extensions: { code: 'FORBIDDEN' } }] }]).ctx, input), errorCode('PERMISSION_DENIED', false))
    await assert.rejects(hashnodeProvider.publish(fixture([{ data: { publishPost: { post: { id: 'created' } } }, errors: [{ extensions: { code: 'FORBIDDEN' } }] }]).ctx, input), errorCode('UNKNOWN_RESULT', true))
  })
  it('Slack verifies the workspace/channel and posts to the bound channel with a stable client message ID', async () => {
    const f = fixture([{ ok: true, team: 'Example', team_id: 'T123', user_id: 'U123' }, { ok: true, channel: { id: 'C123', name: 'publishing' } }, { ok: true, ts: '123.456' }, { ok: true, permalink: 'https://example.slack.com/archives/C123/p123456' }])
    const [account] = await slackProvider.connect(f.ctx, { credentials: { secrets: { accessToken: 'fake-slack' } }, destinationId: 'C123' })
    const input = post('slack'); input.account = account; input.settings.channel = 'C123'
    assert.equal((await slackProvider.publish(f.ctx, input)).remoteId, '123.456')
    assert.equal((f.calls[2].init.body as URLSearchParams).get('client_msg_id'), input.jobId)
    input.settings.channel = 'C999'
    await assert.rejects(slackProvider.publish(f.ctx, input), errorCode('VALIDATION_REJECTED', false))
    assert.equal(f.calls.length, 4)
  })
  it('Slack stages image bytes before a single fenced completion; optional permalink failure keeps a proven publication', async () => {
    const f = fixture([{ ok: true, upload_url: 'https://files.slack.com/upload/example', file_id: 'F123' }, new Response('OK - 3'), { ok: true, files: [{ id: 'F123' }] }])
    const input = post('slack'); input.account.remoteId = 'C123'; input.media = [image]
    assert.equal((await slackProvider.publish(f.ctx, input)).remoteId, 'F123')
    assert.equal(f.events.filter(event => event === 'gate').length, 1)
    assert.equal((f.calls[2].init.body as URLSearchParams).get('initial_comment'), input.text)
    assert.equal((f.calls[2].init.body as URLSearchParams).get('channel_id'), 'C123')
    const text = fixture([{ ok: true, ts: '1.1' }, new Response('', { status: 500 })])
    input.media = []
    assert.equal((await slackProvider.publish(text.ctx, input)).remoteId, '1.1')
  })
  it('Slack classifies missing scopes and lost final responses without leaking provider data', async () => {
    const input = post('slack')
    await assert.rejects(slackProvider.publish(fixture([{ ok: false, error: 'missing_scope' }]).ctx, input), errorCode('PERMISSION_DENIED', false))
    await assert.rejects(slackProvider.publish(fixture([new TypeError('lost-response-with-secret')]).ctx, input), errorCode('UNKNOWN_RESULT', true))
  })
  it('GitHub requires repository write access and publishes a release to that exact repository', async () => {
    const f = fixture([{ full_name: 'example/project', node_id: 'R_example', permissions: { push: true }, html_url: 'https://github.com/example/project' }, { id: 99, html_url: 'https://github.com/example/project/releases/tag/v1' }])
    const [account] = await githubProvider.connect(f.ctx, { credentials: { secrets: { accessToken: 'fake-github' } }, destinationId: 'example/project' })
    const input = post('github'); input.account = account; input.settings = { repo: 'example/project', title: 'Titlu', tag: 'v1' }
    assert.equal((await githubProvider.publish(f.ctx, input)).remoteId, '99')
    assert.deepEqual(body(f, 1), { tag_name: 'v1', name: 'Titlu', body: input.text, draft: false, generate_release_notes: false })
    input.settings.repo = 'example/other'
    await assert.rejects(githubProvider.publish(f.ctx, input), errorCode('PERMISSION_DENIED', false))
    await assert.rejects(githubProvider.connect(fixture([{ permissions: { push: false } }]).ctx, { credentials: input.account.credentials, destinationId: 'example/project' }), errorCode('PERMISSION_DENIED', false))
  })
  it('GitHub resolves a discussion category in the connected repository before publishing', async () => {
    const f = fixture([{ data: { repository: { id: 'R_repo', discussionCategories: { nodes: [{ id: 'D_category', name: 'Announcements', slug: 'announcements' }] } } } }, { data: { createDiscussion: { discussion: { id: 'D_post', url: 'https://github.com/example/project/discussions/1' } } } }])
    const input = post('github'); input.account.remoteId = 'example/project'; input.settings = { repo: 'example/project', post_type: 'discussion', title: 'Titlu', category: 'Announcements' }
    assert.equal((await githubProvider.publish(f.ctx, input)).remoteId, 'D_post')
    assert.equal(body(f, 1).variables.input.categoryId, 'D_category'); assert.equal(body(f, 1).variables.input.repositoryId, 'R_repo')
  })
  it('Listmonk checkpoints its draft before starting delivery and polls that campaign without creating another', async () => {
    const f = fixture([{ data: { id: 7, name: 'Example subscribers' } }, { data: { id: 8, uuid: 'campaign-uuid' } }, { data: { status: 'running' } }, { data: { id: 8, status: 'finished' } }])
    const [account] = await listmonkProvider.connect(f.ctx, { credentials: { secrets: { username: 'api', apiToken: 'fake-token', fromEmail: 'sender@example.test' } }, instanceUrl: 'https://newsletter.example.test', destinationId: '7' })
    const input = post('listmonk'); input.account = account; input.text = '**Continut** aprobat'; input.settings = { title: 'Subiect', subtitle: 'Previzualizare', list: '7' }
    const sent = await listmonkProvider.publish(f.ctx, input)
    assert.equal(sent.status, 'processing'); assert.equal(f.checkpoints[0].remoteId, '8')
    assert.ok(f.events.indexOf('checkpoint') < f.events.indexOf('gate'))
    assert.deepEqual(body(f, 1).lists, [7]); assert.equal(body(f, 2).status, 'running')
    assert.equal(body(f, 1).content_type, 'html'); assert.match(body(f, 1).body, /<strong>Continut<\/strong>/); assert.match(body(f, 1).altbody, /Previzualizare/)
    assert.equal((await listmonkProvider.poll!(f.ctx, account, sent)).status, 'published')
    assert.equal(f.calls.filter(call => call.url.endsWith('/api/campaigns')).length, 1)
    await assert.rejects(listmonkProvider.poll!(fixture([{ data: { id: 8, status: 'cancelled' } }]).ctx, account, sent), NativeProcessingFailedError)
    const lost = fixture([{ data: { id: 9, uuid: 'lost-response-campaign' } }, new Error('Response lost after starting campaign')])
    await assert.rejects(listmonkProvider.publish(lost.ctx, input), errorCode('UNKNOWN_RESULT', true))
    assert.equal(lost.checkpoints[0].remoteId, '9')
    const resume = fixture([{ data: { id: 9, status: 'running' } }])
    assert.equal((await listmonkProvider.poll!(resume.ctx, account, lost.checkpoints[0])).status, 'processing')
    assert.equal(resume.calls.length, 1); assert.match(resume.calls[0].url, /\/api\/campaigns\/9$/)
    assert.equal(resume.calls[0].init.method, undefined)
  })
  it('Stack Exchange binds the account site and publishes an answer through the write API', async () => {
    const f = fixture([{ items: [{ user_id: 17, display_name: 'Example', link: 'https://money.stackexchange.com/users/17/example' }] }, { items: [{ answer_id: 42 }] }])
    const [account] = await stackexchangeProvider.connect(f.ctx, { credentials: { secrets: { accessToken: 'fake-se', apiKey: 'fake-key' } }, destinationId: 'money.stackexchange.com' })
    const input = post('stackexchange'); input.account = account; input.settings = { question_url: 'https://money.stackexchange.com/questions/12/example' }
    assert.equal((await stackexchangeProvider.publish(f.ctx, input)).remoteUrl, 'https://money.stackexchange.com/a/42')
    assert.equal(f.calls[1].url, 'https://api.stackexchange.com/2.3/questions/12/answers/add')
    assert.equal((f.calls[1].init.body as URLSearchParams).get('body'), input.text)
    input.settings.question_url = 'https://stackoverflow.com/questions/12/example'
    await assert.rejects(stackexchangeProvider.publish(f.ctx, input), errorCode('VALIDATION_REJECTED', false))
  })
  it('Stack Exchange reports API error envelopes instead of claiming success', async () => {
    const input = post('stackexchange'); input.account.metadata.site = 'money.stackexchange.com'; input.settings = { post_type: 'question', title: 'Intrebare', tags: ['tax'] }
    await assert.rejects(stackexchangeProvider.publish(fixture([{ error_id: 341, error_name: 'access_token_invalid' }]).ctx, input), errorCode('AUTH_EXPIRED', false))
  })
  it('Farcaster checks the approved signer and uses the durable job ID for provider idempotency', async () => {
    const f = fixture([{ status: 'approved', fid: 17 }, { users: [{ fid: 17, username: 'example' }] }, { cast: { hash: '0x123' } }])
    const [account] = await farcasterProvider.connect(f.ctx, { credentials: { secrets: { apiKey: 'fake-neynar', signerUuid: 'fake-signer' } } })
    const input = post('farcaster'); input.account = account
    assert.equal((await farcasterProvider.publish(f.ctx, input)).remoteId, '0x123'); assert.equal(body(f, 2).idem, input.jobId)
    assert.equal(body(f, 2).text, input.text)
    await assert.rejects(farcasterProvider.connect(fixture([{ status: 'pending_approval', fid: 17 }]).ctx, { credentials: account.credentials }), errorCode('PERMISSION_DENIED', false))
  })
  it('Lemmy v4 login stores only its session, verifies the community and publishes through the selected version', async () => {
    const f = fixture([{ jwt: 'fake-jwt' }, { local_user_view: { person: { id: 1, name: 'example' } } }, { community_view: { community: { id: 2, name: 'example', deleted: false, removed: false } } }, { post_view: { post: { id: 3, ap_id: 'https://lemmy.example.test/post/3' } } }])
    const [account] = await lemmyProvider.connect(f.ctx, { credentials: { secrets: { username: 'example', password: ' private password ', totp: '123456' } }, instanceUrl: 'https://lemmy.example.test', destinationId: '2' })
    assert.deepEqual(account.credentials.secrets, { accessToken: 'fake-jwt' })
    assert.equal(body(f, 0).password, ' private password '); assert.equal(body(f, 0).totp_2fa_token, '123456')
    const input = post('lemmy'); input.account = account; input.settings = { community: 'example', community_id: '2', title: 'Titlu' }
    assert.equal((await lemmyProvider.publish(f.ctx, input)).remoteId, '3'); assert.equal(f.calls[3].url, 'https://lemmy.example.test/api/v4/post')
    input.settings.community_id = '99'; await assert.rejects(lemmyProvider.publish(f.ctx, input), errorCode('VALIDATION_REJECTED', false))
  })
  it('Lemmy falls back to v3 only for an absent v4 endpoint, never after invalid credentials', async () => {
    const input = { credentials: { secrets: { username: 'example', password: 'fake-password' } }, instanceUrl: 'https://lemmy.example.test', destinationId: '2' }
    const f = fixture([new Response('', { status: 404 }), { jwt: 'fake-jwt' }, { my_user: { local_user_view: { person: { id: 1, name: 'example' } } } }, { community_view: { community: { id: 2, name: 'example' } } }])
    assert.equal((await lemmyProvider.connect(f.ctx, input))[0].metadata.apiVersion, 3)
    const denied = fixture([new Response('', { status: 401 })])
    await assert.rejects(lemmyProvider.connect(denied.ctx, input), errorCode('AUTH_EXPIRED', false)); assert.equal(denied.calls.length, 1)
  })
  it('blocks expiring attachment links for text-only API paths before approval or remote writes', async () => {
    for (const platform of ['github', 'stackexchange', 'farcaster', 'lemmy'] as const) {
      const input = post(platform); input.media = [image]; input.settings.repo = input.account.remoteId = 'example/project'
      if (platform === 'stackexchange') input.account.metadata.site = 'money.stackexchange.com'
      if (platform === 'lemmy') { input.account.metadata.communityId = '2'; input.account.metadata.communityName = 'example'; input.settings = { community_id: '2', community: 'example' } }
      const validation = { platform, text: input.text, settings: input.settings, media: [image] }
      assert.ok(validateDestination({ ...validation, rules: { native: true } }).errors.some(error => error.code === 'NATIVE_TEXT_ONLY'))
      assert.ok(!validateDestination(validation).errors.some(error => error.code === 'NATIVE_TEXT_ONLY'))
      const f = fixture([])
      await assert.rejects(nativeProvider(platform).publish(f.ctx, input), errorCode('VALIDATION_REJECTED', false))
      assert.equal(f.calls.length, 0)
    }
  })
})
