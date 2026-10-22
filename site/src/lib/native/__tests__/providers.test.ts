import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { blueskyProvider, linkFacets } from '../providers/bluesky.ts'
import { devtoProvider } from '../providers/devto.ts'
import { telegramProvider } from '../providers/telegram.ts'
import { isPrivateAddress, instanceUrl } from '../providers/shared.ts'
import { NativeProviderError } from '../http.ts'
import type { NativeContext, NativePublishInput } from '../types.ts'

function fakeContext(responses: unknown[]) {
  const calls: Array<{ url: string; options: RequestInit }> = []
  const ctx: NativeContext = {
    fetch: async (url, options = {}) => { calls.push({ url: String(url), options }); assert.ok(responses.length, 'unexpected network request'); return Response.json(responses.shift()) },
    now: () => new Date('2030-01-01T12:00:00Z'),
    readMedia: async () => new Uint8Array([1, 2, 3]), publicMediaUrl: async () => 'https://media.example.test/approved-image',
  }
  return { ctx, calls }
}
function input(platform: NativePublishInput['account']['platform'], secrets: Record<string, string>): NativePublishInput {
  return { jobId: 'example-job', attemptNo: 1, idempotencyKey: '3m3example2345', text: 'Salut https://example.test', settings: {},
    media: [], scheduledAt: '2030-01-01T12:00:00Z',
    account: { platform, remoteId: 'remote-1', displayName: 'Example', metadata: {}, credentials: { secrets } } }
}

describe('independent platform adapters with fake HTTP', () => {
  it('dev.to connects an existing user and publishes the approved article fields', async () => {
    const { ctx, calls } = fakeContext([{ id: 10, username: 'example', name: 'Example' }, { id: 20, url: 'https://dev.to/example/article' }])
    const [account] = await devtoProvider.connect(ctx, { credentials: { secrets: { apiKey: 'private-key' } } })
    const post = { ...input('devto', {}), account, settings: { title: 'Titlu', canonical_url: 'https://example.test/article', tags: ['one', 'two'] } }
    assert.equal((await devtoProvider.publish(ctx, post)).remoteId, '20')
    assert.equal(new Headers(calls[1].options.headers).get('api-key'), 'private-key')
    assert.deepEqual(JSON.parse(String(calls[1].options.body)), { article: { title: 'Titlu', body_markdown: post.text, published: true, tags: 'one,two', canonical_url: 'https://example.test/article' } })
  })
  it('dev.to refuses a missing title without publishing', async () => {
    const { ctx, calls } = fakeContext([])
    await assert.rejects(devtoProvider.publish(ctx, input('devto', { apiKey: 'key' })), (error: unknown) => error instanceof NativeProviderError && !error.ambiguous)
    assert.equal(calls.length, 0)
  })
  it('Telegram verifies channel permission and uses the verified chat ID', async () => {
    const ok = (result: unknown) => ({ ok: true, result })
    const { ctx, calls } = fakeContext([ok({ id: 77 }), ok({ id: -10012345, type: 'channel', title: 'Example', username: 'example_channel' }), ok({ status: 'administrator', can_post_messages: true }), ok({ message_id: 8, chat: { id: -10012345, username: 'example_channel' } })])
    const [account] = await telegramProvider.connect(ctx, { credentials: { secrets: { botToken: '123:test-token' } }, destinationId: '@example_channel' })
    const result = await telegramProvider.publish(ctx, { ...input('telegram', {}), account })
    assert.equal(result.remoteUrl, 'https://t.me/example_channel/8')
    assert.equal(JSON.parse(String(calls[3].options.body)).chat_id, '-10012345')
  })
  it('Telegram sends media bytes as multipart rather than requiring a public tunnel', async () => {
    const { ctx, calls } = fakeContext([{ ok: true, result: { message_id: 42, chat: { id: -100123 } } }])
    const post = input('telegram', { botToken: '123:test-token' })
    post.media = [{ id: 'asset', mime: 'image/png', bytes: 3, sha256: 'unused-in-adapter-test', altText: 'Imagine', width: 10, height: 10, filename: 'asset.png' }]
    assert.equal((await telegramProvider.publish(ctx, post)).remoteUrl, 'https://t.me/c/123/42')
    const body = calls[0].options.body as FormData
    assert.equal(body.get('caption'), post.text)
    assert.equal((body.get('photo') as Blob).size, 3)
  })
  it('Bluesky stores session tokens instead of the submitted app password', async () => {
    const { ctx } = fakeContext([{ did: 'did:plc:example', handle: 'example.test', accessJwt: 'access', refreshJwt: 'refresh' }, { displayName: 'Example' }])
    const [account] = await blueskyProvider.connect(ctx, { credentials: { secrets: { identifier: 'example.test', password: 'app-password' } } })
    assert.deepEqual(account.credentials.secrets, { accessToken: 'access', refreshToken: 'refresh' })
    assert.ok(!JSON.stringify(account).includes('app-password'))
  })
  it('Bluesky uses UTF-8 facet indices and the durable record key', async () => {
    const post = input('bluesky', { accessToken: 'token' })
    post.account.remoteId = 'did:plc:example'
    post.account.metadata.instanceUrl = 'https://bsky.social'
    post.text = 'Bună 🌱 https://example.test.'
    assert.deepEqual(linkFacets(post.text)[0].index, { byteStart: Buffer.byteLength('Bună 🌱 '), byteEnd: Buffer.byteLength('Bună 🌱 https://example.test') })
    const { ctx, calls } = fakeContext([{ uri: `at://did:plc:example/app.bsky.feed.post/${post.idempotencyKey}`, cid: 'cid-example' }])
    await blueskyProvider.publish(ctx, post)
    const body = JSON.parse(String(calls[0].options.body))
    assert.equal(body.rkey, post.idempotencyKey)
    assert.equal(body.record.text, post.text)
  })
  it('refuses private instances, mapped loopback and credential-bearing URLs', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fd12::1', '169.254.169.254']) assert.equal(isPrivateAddress(address), true, address)
    for (const url of ['http://example.test', 'https://localhost', 'https://127.0.0.1', 'https://[::ffff:7f00:1]', 'https://user:password@example.test']) assert.throws(() => instanceUrl(url), url)
    assert.equal(instanceUrl('https://example.test/'), 'https://example.test')
  })
})
