import { bearer, nativeRequest, NativeProviderError } from '../http.ts'
import { oauthConfig } from '../oauth-config.ts'
import { refreshOAuthToken } from '../oauth.ts'
import { requireSecret, stringSetting, type NativeProvider } from '../types.ts'
import { metricSnapshot, publishedId, publicHttpsUrl, requiredString } from './shared.ts'

const BASE = 'https://api.x.com/2'
/** Independent X API v2 adapter: https://docs.x.com/x-api/posts/create-post */
export const xProvider: NativeProvider = {
  platform: 'x',
  async connect(ctx, input) {
    const { data } = await nativeRequest<{ data: { id: string; name: string; username: string; profile_image_url?: string } }>(ctx, `${BASE}/users/me?user.fields=profile_image_url`, { headers: bearer(requireSecret(input.credentials, 'accessToken')) })
    const user = data.data
    return [{ platform: 'x', remoteId: requiredString(user?.id), displayName: requiredString(user?.name),
      profileUrl: `https://x.com/${encodeURIComponent(requiredString(user.username))}`, pictureUrl: publicHttpsUrl(user.profile_image_url),
      metadata: { username: user.username }, credentials: input.credentials }]
  },
  refresh: (ctx, account) => refreshOAuthToken(ctx, oauthConfig('x'), account.credentials),
  async publish(ctx, input) {
    if (input.media.length > 4 || input.media.some((item) => !item.mime.startsWith('image/'))) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const headers = bearer(requireSecret(input.account, 'accessToken'))
    const ids: string[] = []
    for (const media of input.media) {
      const { data } = await nativeRequest<{ data: { id: string } }>(ctx, `${BASE}/media/upload`, { method: 'POST', headers,
        body: { media: Buffer.from(await ctx.readMedia(media)).toString('base64'), media_category: 'tweet_image', media_type: media.mime }, timeoutMs: 120_000 })
      const id = requiredString(data.data?.id)
      await nativeRequest(ctx, `${BASE}/media/metadata`, { method: 'POST', headers, body: { id, metadata: { alt_text: { text: media.altText } } } })
      ids.push(id)
    }
    const reply = stringSetting(input.settings, 'who_can_reply')
    const replySettings: Record<string, string> = { following: 'following', mentioned_users: 'mentionedUsers', mentionedUsers: 'mentionedUsers', verified: 'verified', subscribers: 'subscribers' }
    const { data } = await nativeRequest<{ data: { id: string } }>(ctx, `${BASE}/tweets`, { method: 'POST', headers, write: true,
      body: { text: input.text, ...(ids.length ? { media: { media_ids: ids } } : {}), ...(replySettings[reply] ? { reply_settings: replySettings[reply] } : {}) } })
    const id = publishedId(data.data?.id)
    return { remoteId: id, remoteUrl: `https://x.com/i/web/status/${encodeURIComponent(id)}`, status: 'published' }
  },
  async metrics(ctx, account, remoteId) {
    if (!remoteId) return metricSnapshot(ctx.now(), {}, ['views', 'likes', 'comments', 'shares'])
    const { data } = await nativeRequest<{ data: { public_metrics?: { impression_count?: number; like_count?: number; reply_count?: number; retweet_count?: number } } }>(ctx,
      `${BASE}/tweets/${encodeURIComponent(remoteId)}?tweet.fields=public_metrics`, { headers: bearer(requireSecret(account, 'accessToken')) })
    const m = data.data?.public_metrics
    return metricSnapshot(ctx.now(), { views: m?.impression_count, likes: m?.like_count, comments: m?.reply_count, shares: m?.retweet_count }, ['views', 'likes', 'comments', 'shares'])
  },
}
