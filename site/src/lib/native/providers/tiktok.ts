import { bearer, nativeRequest, NativeProviderError, NativeProcessingFailedError } from '../http.ts'
import { oauthConfig } from '../oauth-config.ts'
import { refreshOAuthToken } from '../oauth.ts'
import { requireSecret, stringSetting, type NativeContext, type NativeCredentials, type NativeProvider } from '../types.ts'
import { publicHttpsUrl, publishedId, requiredString } from './shared.ts'

const BASE = 'https://open.tiktokapis.com/v2'
interface TikTokResponse<T> { data: T; error?: { code?: string } }
export interface TikTokCreator { creator_username: string; creator_nickname: string; creator_avatar_url?: string; privacy_level_options: string[]; comment_disabled: boolean; duet_disabled: boolean; stitch_disabled: boolean; max_video_post_duration_sec: number }
async function api<T>(ctx: NativeContext, token: string, path: string, body?: Record<string, unknown>, write = false): Promise<T> {
  const { data } = await nativeRequest<TikTokResponse<T>>(ctx, `${BASE}${path}`, { method: body ? 'POST' : 'GET', headers: bearer(token), body, write })
  const code = data?.error?.code
  if (code !== 'ok') {
    if (['access_token_invalid', 'invalid_access_token', 'token_expired'].includes(code || '')) throw new NativeProviderError('AUTH_EXPIRED', 401, false)
    if (code === 'scope_not_authorized') throw new NativeProviderError('PERMISSION_DENIED', 403, false)
    if (code === 'rate_limit_exceeded') throw new NativeProviderError('RATE_LIMITED', 429, false, 60)
    if (!code || code === 'internal_error') throw new NativeProviderError(write ? 'UNKNOWN_RESULT' : 'TEMPORARY_FAILURE', 502, write)
    throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
  }
  return data.data
}
export async function tiktokCreatorInfo(ctx: NativeContext, credentials: NativeCredentials): Promise<TikTokCreator> {
  return api<TikTokCreator>(ctx, requireSecret(credentials, 'accessToken'), '/post/publish/creator_info/query/', {})
}
/** https://developers.tiktok.com/docs/en/content-posting-api-get-started */
export const tiktokProvider: NativeProvider = {
  platform: 'tiktok',
  async connect(ctx, input) {
    const token = requireSecret(input.credentials, 'accessToken')
    const { user } = await api<{ user: { open_id: string; display_name: string; avatar_url?: string } }>(ctx, token, '/user/info/?fields=open_id,display_name,avatar_url')
    const creator = await tiktokCreatorInfo(ctx, input.credentials)
    return [{ platform: 'tiktok', remoteId: requiredString(user.open_id), displayName: creator.creator_nickname || requiredString(user.display_name),
      pictureUrl: publicHttpsUrl(user.avatar_url), profileUrl: `https://www.tiktok.com/@${encodeURIComponent(requiredString(creator.creator_username))}`,
      metadata: { username: creator.creator_username, privacyLevelOptions: creator.privacy_level_options,
        commentDisabled: creator.comment_disabled, duetDisabled: creator.duet_disabled, stitchDisabled: creator.stitch_disabled,
        maxVideoDurationSeconds: creator.max_video_post_duration_sec }, credentials: input.credentials }]
  },
  refresh: (ctx, account) => refreshOAuthToken(ctx, oauthConfig('tiktok'), account.credentials),
  async publish(ctx, input) {
    const token = requireSecret(input.account, 'accessToken')
    const creator = await tiktokCreatorInfo(ctx, input.account.credentials)
    const privacy = stringSetting(input.settings, 'privacy_level')
    if (!creator.privacy_level_options?.includes(privacy) || stringSetting(input.settings, 'publish_consent') !== 'yes' || !input.media.length) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const commercial = stringSetting(input.settings, 'commercial_content', 'NONE')
    if (!['NONE', 'OWN_BRAND', 'PAID_PARTNERSHIP'].includes(commercial) || (commercial === 'PAID_PARTNERSHIP' && privacy === 'SELF_ONLY')) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const postInfo = { privacy_level: privacy, disable_comment: creator.comment_disabled || stringSetting(input.settings, 'allow_comments') !== 'yes',
      brand_organic_toggle: commercial === 'OWN_BRAND', brand_content_toggle: commercial === 'PAID_PARTNERSHIP', is_aigc: stringSetting(input.settings, 'synthetic_media') === 'true' }
    const videos = input.media.filter((media) => media.mime.startsWith('video/'))
    if (!videos.length) {
      if (input.media.length > 35) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
      const photos = []
      for (const media of input.media) photos.push(await ctx.publicMediaUrl(media, { jpeg: true }))
      const data = await api<{ publish_id: string }>(ctx, token, '/post/publish/content/init/', { post_mode: 'DIRECT_POST', media_type: 'PHOTO',
        post_info: { ...postInfo, title: stringSetting(input.settings, 'title'), description: input.text }, source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: photos } }, true)
      return { remoteId: publishedId(data.publish_id), status: 'processing' }
    }
    const media = videos[0]
    if (videos.length !== 1 || input.media.length !== 1 || media.mime !== 'video/mp4' || !media.durationSeconds || media.durationSeconds > creator.max_video_post_duration_sec) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const bytes = await ctx.readMedia(media)
    const chunkSize = Math.min(bytes.length, 10 * 1024 * 1024)
    const chunkCount = Math.max(1, Math.floor(bytes.length / chunkSize))
    const data = await api<{ publish_id: string; upload_url: string }>(ctx, token, '/post/publish/video/init/', {
      post_info: { ...postInfo, title: input.text, disable_duet: creator.duet_disabled || stringSetting(input.settings, 'allow_duet') !== 'yes', disable_stitch: creator.stitch_disabled || stringSetting(input.settings, 'allow_stitch') !== 'yes' },
      source_info: { source: 'FILE_UPLOAD', video_size: bytes.length, chunk_size: chunkSize, total_chunk_count: chunkCount },
    })
    const id = requiredString(data.publish_id)
    await ctx.checkpoint?.({ remoteId: id, status: 'processing' })
    const url = new URL(requiredString(data.upload_url))
    if (url.protocol !== 'https:' || !(url.hostname === 'tiktokapis.com' || url.hostname.endsWith('.tiktokapis.com'))) throw new NativeProviderError('INVALID_RESPONSE', 200, false)
    for (let index = 0; index < chunkCount; index++) {
      const start = index * chunkSize
      const end = index === chunkCount - 1 ? bytes.length : start + chunkSize
      await nativeRequest(ctx, url, { method: 'PUT', headers: { 'content-type': media.mime, 'content-length': String(end - start), 'content-range': `bytes ${start}-${end - 1}/${bytes.length}` },
        body: new Blob([new Uint8Array(bytes.subarray(start, end))], { type: media.mime }), write: true, timeoutMs: 120_000 })
    }
    return { remoteId: id, status: 'processing' }
  },
  async poll(ctx, account, publication) {
    const data = await api<{ status: string; publicaly_available_post_id?: Array<string | number> }>(ctx, requireSecret(account, 'accessToken'), '/post/publish/status/fetch/', { publish_id: publication.remoteId })
    if (data.status === 'FAILED') throw new NativeProcessingFailedError()
    if (data.status !== 'PUBLISH_COMPLETE') return publication
    const id = data.publicaly_available_post_id?.[0]
    // Avoid constructing a wrong URL from a rounded 64-bit JSON number.
    const publicId = typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id)) ? String(id) : undefined
    const username = account.metadata.username
    return { ...publication, status: 'published', remoteUrl: publicId && typeof username === 'string' ? `https://www.tiktok.com/@${encodeURIComponent(username)}/video/${publicId}` : undefined }
  },
}
