import { nativeRequest } from '../http.ts'
import { requireSecret, stringSetting, type NativeProvider } from '../types.ts'
import { metricSnapshot, publicHttpsUrl, publishedId, requiredString, tagsOf, titleOf } from './shared.ts'

const BASE = 'https://dev.to/api'
const headers = (token: string) => ({ 'api-key': token, accept: 'application/vnd.forem.api-v1+json' })

interface User { id: number; username: string; name?: string; profile_image?: string }
interface Article { id: number; url: string; page_views_count?: number; public_reactions_count?: number; comments_count?: number }

/** Official API: https://developers.forem.com/api/v1 */
export const devtoProvider: NativeProvider = {
  platform: 'devto',
  async connect(ctx, input) {
    const token = requireSecret(input.credentials, 'apiKey')
    const { data } = await nativeRequest<User>(ctx, `${BASE}/users/me`, { headers: headers(token) })
    const remoteId = requiredString(data.id)
    const username = requiredString(data.username)
    return [{ platform: 'devto', remoteId, displayName: data.name || username, profileUrl: `https://dev.to/${encodeURIComponent(username)}`, pictureUrl: publicHttpsUrl(data.profile_image), metadata: { username }, credentials: { secrets: { apiKey: token } } }]
  },
  async publish(ctx, input) {
    const article: Record<string, unknown> = {
      title: titleOf(input), body_markdown: input.text, published: true,
      tags: tagsOf(input.settings).slice(0, 4).join(','),
    }
    const canonical = stringSetting(input.settings, 'canonical_url')
    if (canonical) article.canonical_url = canonical
    const subtitle = stringSetting(input.settings, 'subtitle')
    if (subtitle) article.description = subtitle
    if (input.media[0]) article.main_image = await ctx.publicMediaUrl(input.media[0])
    const { data } = await nativeRequest<Article>(ctx, `${BASE}/articles`, { method: 'POST', headers: headers(requireSecret(input.account, 'apiKey')), body: { article }, write: true })
    return { remoteId: publishedId(data?.id), remoteUrl: publicHttpsUrl(data?.url), status: 'published' }
  },
  async metrics(ctx, account, remoteId) {
    if (!remoteId || !/^\d+$/.test(remoteId)) return metricSnapshot(ctx.now(), {}, ['views', 'likes', 'comments'])
    const { data } = await nativeRequest<Article>(ctx, `${BASE}/articles/${remoteId}`, { headers: headers(requireSecret(account, 'apiKey')) })
    return metricSnapshot(ctx.now(), { views: data.page_views_count, likes: data.public_reactions_count, comments: data.comments_count }, ['views', 'likes', 'comments'])
  },
}
