import { nativeRequest, bearer, NativeProviderError } from '../http.ts'
import { requireSecret, type JsonObject, type NativeCredentials, type NativeProvider } from '../types.ts'
import { accountInstance, instanceUrl, mediaBlob, metricSnapshot, publicHttpsUrl, publishedId, requiredString } from './shared.ts'

interface Session { did: string; handle: string; accessJwt: string; refreshJwt: string; active?: boolean }
interface Profile { displayName?: string; avatar?: string; followersCount?: number }

function sessionCredentials(session: Session): NativeCredentials {
  const credentials: NativeCredentials = { secrets: { accessToken: requiredString(session.accessJwt), refreshToken: requiredString(session.refreshJwt) } }
  try {
    const payload = JSON.parse(Buffer.from(session.accessJwt.split('.')[1], 'base64url').toString('utf8')) as { exp?: unknown }
    if (typeof payload.exp === 'number' && Number.isFinite(payload.exp) && payload.exp > 0 && payload.exp < 253_402_300_799) credentials.expiresAt = new Date(payload.exp * 1000).toISOString()
  } catch { /* Expiry is only a hint; the PDS validates the token on every request. */ }
  return credentials
}

/** UTF-8 byte offsets are required by AT Protocol rich-text facets. */
export function linkFacets(text: string): JsonObject[] {
  const facets: JsonObject[] = []
  for (const match of text.matchAll(/https?:\/\/[^\s<>]+/g)) {
    const uri = match[0].replace(/[.,!?;:)\]}]+$/, '')
    const start = match.index ?? 0
    facets.push({ index: { byteStart: Buffer.byteLength(text.slice(0, start)), byteEnd: Buffer.byteLength(text.slice(0, start) + uri) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri }] })
  }
  return facets
}

/** Official lexicons: https://github.com/bluesky-social/atproto/tree/main/lexicons/com/atproto */
export const blueskyProvider: NativeProvider = {
  platform: 'bluesky',
  async connect(ctx, input) {
    const instance = instanceUrl(input.instanceUrl || 'https://bsky.social')
    const { data: session } = await nativeRequest<Session>(ctx, `${instance}/xrpc/com.atproto.server.createSession`, {
      method: 'POST', body: { identifier: requireSecret(input.credentials, 'identifier'), password: requireSecret(input.credentials, 'password'), ...(input.credentials.secrets.authFactorToken ? { authFactorToken: input.credentials.secrets.authFactorToken } : {}) },
    })
    if (session.active === false) throw new NativeProviderError('PERMISSION_DENIED', 403, false)
    const did = requiredString(session.did)
    const handle = requiredString(session.handle)
    const { data: profile } = await nativeRequest<Profile>(ctx, `${instance}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`, { headers: bearer(session.accessJwt) })
    return [{ platform: 'bluesky', remoteId: did, displayName: profile.displayName || handle, profileUrl: `https://bsky.app/profile/${encodeURIComponent(handle)}`, pictureUrl: publicHttpsUrl(profile.avatar), metadata: { instanceUrl: instance, handle }, credentials: sessionCredentials(session) }]
  },
  async refresh(ctx, account) {
    const { data } = await nativeRequest<Session>(ctx, `${accountInstance(account)}/xrpc/com.atproto.server.refreshSession`, { method: 'POST', headers: bearer(requireSecret(account, 'refreshToken')) })
    if (data.did !== account.remoteId) throw new NativeProviderError('AUTH_EXPIRED', 401, false)
    return sessionCredentials(data)
  },
  async publish(ctx, input) {
    if (input.media.length > 4 || input.media.some((media) => !media.mime.startsWith('image/'))) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const instance = accountInstance(input.account)
    const headers = bearer(requireSecret(input.account, 'accessToken'))
    const images: JsonObject[] = []
    for (const media of input.media) {
      const { data } = await nativeRequest<{ blob: JsonObject }>(ctx, `${instance}/xrpc/com.atproto.repo.uploadBlob`, { method: 'POST', headers: { ...headers, 'content-type': media.mime }, body: await mediaBlob(ctx, media), timeoutMs: 120_000 })
      if (!data.blob) throw new NativeProviderError('INVALID_RESPONSE', 200, false)
      images.push({ alt: media.altText, image: data.blob, aspectRatio: { width: media.width, height: media.height } })
    }
    const record: JsonObject = { $type: 'app.bsky.feed.post', text: input.text, createdAt: ctx.now().toISOString(), facets: linkFacets(input.text) }
    if (images.length) record.embed = { $type: 'app.bsky.embed.images', images }
    const { data } = await nativeRequest<{ uri: string; cid: string }>(ctx, `${instance}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST', headers, body: { repo: input.account.remoteId, collection: 'app.bsky.feed.post', rkey: input.idempotencyKey, record }, write: true,
    })
    const uri = publishedId(data?.uri)
    const rkey = uri.split('/').pop()!
    const metadata: JsonObject = {}
    if (typeof data.cid === 'string') metadata.cid = data.cid
    return { remoteId: uri, remoteUrl: `https://bsky.app/profile/${encodeURIComponent(input.account.remoteId)}/post/${encodeURIComponent(rkey)}`, status: 'published', metadata }
  },
  async metrics(ctx, account, remoteId) {
    const base = accountInstance(account)
    const headers = bearer(requireSecret(account, 'accessToken'))
    if (remoteId) {
      const { data } = await nativeRequest<{ posts: Array<{ likeCount?: number; replyCount?: number; repostCount?: number }> }>(ctx, `${base}/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(remoteId)}`, { headers })
      const post = data.posts?.[0]
      return metricSnapshot(ctx.now(), { likes: post?.likeCount, comments: post?.replyCount, shares: post?.repostCount }, ['likes', 'comments', 'shares', 'views'])
    }
    const { data } = await nativeRequest<Profile>(ctx, `${base}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(account.remoteId)}`, { headers })
    return metricSnapshot(ctx.now(), { followers: data.followersCount }, ['followers'])
  },
  async revoke(ctx, account) {
    await nativeRequest(ctx, `${accountInstance(account)}/xrpc/com.atproto.server.deleteSession`, { method: 'POST', headers: bearer(requireSecret(account, 'refreshToken')) })
  },
}
