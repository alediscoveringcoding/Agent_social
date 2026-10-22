import { bearer, nativeRequest, NativeProviderError, NativeProcessingFailedError } from '../http.ts'
import { oauthConfig } from '../oauth-config.ts'
import { refreshOAuthToken } from '../oauth.ts'
import { requireSecret, stringSetting, type NativePublication, type NativeProvider } from '../types.ts'
import { mediaBlob, metricSnapshot, publishedId, publicHttpsUrl, requiredString, tagsOf, titleOf } from './shared.ts'

const BASE = 'https://www.googleapis.com/youtube/v3'
interface Video { id: string; status?: { uploadStatus?: string }; processingDetails?: { processingStatus?: string }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }
function uploaded(video: Video): NativePublication {
  const id = publishedId(video?.id)
  return { remoteId: id, remoteUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, status: 'processing' }
}
function sessionUrl(value: string): URL {
  const url = new URL(value)
  if (url.origin !== 'https://www.googleapis.com' || url.username || url.password || url.pathname !== '/upload/youtube/v3/videos') throw new NativeProviderError('INVALID_RESPONSE', 200, false)
  return url
}
/** https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol */
export const youtubeProvider: NativeProvider = {
  platform: 'youtube',
  async connect(ctx, input) {
    const { data } = await nativeRequest<{ items: Array<{ id: string; snippet: { title: string; thumbnails?: { default?: { url?: string } } } }> }>(ctx,
      `${BASE}/channels?part=snippet&mine=true&maxResults=50`, { headers: bearer(requireSecret(input.credentials, 'accessToken')) })
    return (data.items || []).map((item) => ({ platform: 'youtube' as const, remoteId: requiredString(item.id), displayName: requiredString(item.snippet.title),
      profileUrl: `https://www.youtube.com/channel/${encodeURIComponent(item.id)}`, pictureUrl: publicHttpsUrl(item.snippet.thumbnails?.default?.url), metadata: {}, credentials: input.credentials }))
  },
  refresh: (ctx, account) => refreshOAuthToken(ctx, oauthConfig('youtube'), account.credentials),
  async publish(ctx, input) {
    const media = input.media[0]
    const privacy = stringSetting(input.settings, 'privacy_status')
    const kids = stringSetting(input.settings, 'made_for_kids')
    if (input.media.length !== 1 || media?.mime !== 'video/mp4' || !['private', 'unlisted', 'public'].includes(privacy) || !['true', 'false'].includes(kids)) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const token = requireSecret(input.account, 'accessToken')
    const { data: channels } = await nativeRequest<{ items: Array<{ id: string }> }>(ctx, `${BASE}/channels?part=id&mine=true`, { headers: bearer(token) })
    if (channels.items?.length !== 1 || channels.items[0].id !== input.account.remoteId) throw new NativeProviderError('PERMISSION_DENIED', 403, false)
    const { response } = await nativeRequest(ctx, 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
      method: 'POST', headers: { ...bearer(token), 'x-upload-content-type': media.mime, 'x-upload-content-length': String(media.bytes) },
      body: { snippet: { title: titleOf(input), description: input.text, tags: tagsOf(input.settings), categoryId: '22' },
        status: { privacyStatus: privacy, selfDeclaredMadeForKids: kids === 'true', containsSyntheticMedia: stringSetting(input.settings, 'synthetic_media') === 'true' } },
    })
    const url = sessionUrl(requiredString(response.headers.get('location')))
    const checkpoint: NativePublication = { remoteId: `upload:${input.jobId}`, status: 'processing', metadata: { phase: 'upload', bytes: media.bytes }, privateData: { sessionUrl: url.href } }
    await ctx.checkpoint?.(checkpoint)
    const { data } = await nativeRequest<Video>(ctx, url, { method: 'PUT', headers: { ...bearer(token), 'content-type': media.mime, 'content-length': String(media.bytes) },
      body: await mediaBlob(ctx, media), timeoutMs: 240_000, write: true })
    return uploaded(data)
  },
  async poll(ctx, account, publication) {
    const auth = bearer(requireSecret(account, 'accessToken'))
    if (publication.metadata?.phase === 'upload') {
      const raw = publication.privateData?.sessionUrl
      if (!raw) throw new NativeProviderError('UNKNOWN_RESULT', 0, true)
      const { data, response } = await nativeRequest<Video>(ctx, sessionUrl(raw), { method: 'PUT', headers: { ...auth,
        'content-length': '0', 'content-range': `bytes */${String(publication.metadata.bytes)}` }, acceptStatuses: [308] })
      return response.status === 308 ? publication : uploaded(data)
    }
    const { data } = await nativeRequest<{ items: Video[] }>(ctx, `${BASE}/videos?part=status,processingDetails&id=${encodeURIComponent(publication.remoteId)}`, { headers: auth })
    const video = data.items?.[0]
    if (!video) throw new NativeProviderError('UNKNOWN_RESULT', 404, true)
    if (['failed', 'rejected', 'deleted'].includes(video.status?.uploadStatus || '') || ['failed', 'terminated'].includes(video.processingDetails?.processingStatus || '')) throw new NativeProcessingFailedError()
    if (video.status?.uploadStatus === 'processed' || video.processingDetails?.processingStatus === 'succeeded') return { ...publication, status: 'published' }
    return publication
  },
  async metrics(ctx, account, remoteId) {
    if (!remoteId) return metricSnapshot(ctx.now(), {}, ['views', 'likes', 'comments'])
    const { data } = await nativeRequest<{ items: Video[] }>(ctx, `${BASE}/videos?part=statistics&id=${encodeURIComponent(remoteId)}`, { headers: bearer(requireSecret(account, 'accessToken')) })
    const stats = data.items?.[0]?.statistics
    const number = (value: string | undefined) => value === undefined ? undefined : Number(value)
    return metricSnapshot(ctx.now(), { views: number(stats?.viewCount), likes: number(stats?.likeCount), comments: number(stats?.commentCount) }, ['views', 'likes', 'comments'])
  },
}
