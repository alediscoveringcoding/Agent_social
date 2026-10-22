import { bearer, nativeRequest, NativeProviderError } from '../http.ts'
import { tokenCredentials } from '../oauth.ts'
import { requireSecret, stringSetting, type NativeAccount, type NativeContext, type NativeProvider } from '../types.ts'
import { mediaBlob, metricSnapshot, publishedId, publicHttpsUrl, requiredString } from './shared.ts'

function version(): string {
  const value = process.env.META_GRAPH_VERSION || ''
  if (!/^v\d{2}\.\d+$/.test(value)) throw new Error('NATIVE_SETUP_REQUIRED:META_GRAPH_VERSION')
  return value
}
const graph = () => `https://graph.facebook.com/${version()}`
const instagram = () => `https://graph.instagram.com/${version()}`

/** Meta Pages API: https://developers.facebook.com/docs/pages-api/posts */
export const facebookProvider: NativeProvider = {
  platform: 'facebook',
  async connect(ctx, input) {
    const accounts: NativeAccount[] = []
    const token = requireSecret(input.credentials, 'accessToken')
    let cursor = ''
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({ fields: 'id,name,access_token,link,picture,tasks', limit: '100', ...(cursor ? { after: cursor } : {}) })
      const { data } = await nativeRequest<{ data: Array<{ id: string; name: string; access_token: string; link?: string; picture?: { data?: { url?: string } }; tasks?: string[] }>; paging?: { cursors?: { after?: string }; next?: string } }>(ctx, `${graph()}/me/accounts?${params}`, { headers: bearer(token) })
      for (const item of data.data ?? []) {
        if (item.tasks && !item.tasks.some((task) => ['CREATE_CONTENT', 'MANAGE', 'PROFILE_PLUS_CREATE_CONTENT'].includes(task))) continue
        accounts.push({ platform: 'facebook', remoteId: requiredString(item.id), displayName: requiredString(item.name),
          profileUrl: publicHttpsUrl(item.link) || `https://www.facebook.com/${encodeURIComponent(item.id)}`, pictureUrl: publicHttpsUrl(item.picture?.data?.url),
          metadata: {}, credentials: { secrets: { accessToken: requiredString(item.access_token) } } })
      }
      cursor = data.paging?.cursors?.after || ''
      if (!data.paging?.next || !cursor) break
    }
    return accounts
  },
  async publish(ctx, input) {
    if (input.media.some((item) => !item.mime.startsWith('image/')) || input.media.length > 10) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const base = `${graph()}/${encodeURIComponent(input.account.remoteId)}`
    const headers = bearer(requireSecret(input.account, 'accessToken'))
    const attachments: Array<{ media_fbid: string }> = []
    for (const media of input.media) {
      const form = new FormData()
      form.set('source', await mediaBlob(ctx, media), media.filename)
      form.set('published', 'false')
      form.set('alt_text_custom', media.altText)
      const { data } = await nativeRequest<{ id: string }>(ctx, `${base}/photos`, { method: 'POST', headers, body: form, timeoutMs: 120_000 })
      attachments.push({ media_fbid: requiredString(data.id) })
    }
    const { data } = await nativeRequest<{ id: string }>(ctx, `${base}/feed`, { method: 'POST', headers, write: true,
      body: { message: input.text, ...(attachments.length ? { attached_media: attachments } : {}) } })
    const id = publishedId(data?.id)
    return { remoteId: id, remoteUrl: `https://www.facebook.com/${encodeURIComponent(id)}`, status: 'published' }
  },
  async metrics(ctx, account) {
    const { data } = await nativeRequest<{ followers_count?: number }>(ctx, `${graph()}/${encodeURIComponent(account.remoteId)}?fields=followers_count`, { headers: bearer(requireSecret(account, 'accessToken')) })
    return metricSnapshot(ctx.now(), { followers: data.followers_count }, ['followers'])
  },
}

async function readyContainer(ctx: NativeContext, token: string, id: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const { data } = await nativeRequest<{ status_code: string }>(ctx, `${instagram()}/${encodeURIComponent(id)}?fields=status_code`, { headers: bearer(token) })
    if (data.status_code === 'FINISHED') return
    if (['ERROR', 'EXPIRED'].includes(data.status_code)) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    // These are unpublished containers. A later retry is safe if processing
    // exceeds this request's budget; media_publish has not been invoked yet.
    if (i < 19) await new Promise<void>((resolve) => setTimeout(resolve, 2000))
  }
  throw new NativeProviderError('TEMPORARY_FAILURE', 0, false, 120)
}
/** Instagram Login: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login */
export const instagramProvider: NativeProvider = {
  platform: 'instagram',
  async connect(ctx, input) {
    let credentials = input.credentials
    const exchange = new URL('https://graph.instagram.com/access_token')
    exchange.search = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: process.env.INSTAGRAM_CLIENT_SECRET || '', access_token: requireSecret(credentials, 'accessToken') }).toString()
    const { data: longLived } = await nativeRequest<{ access_token: string; expires_in: number }>(ctx, exchange)
    credentials = tokenCredentials(longLived, ctx.now())
    const { data } = await nativeRequest<{ id?: string; user_id?: string; username: string; name?: string; profile_picture_url?: string }>(ctx, `${instagram()}/me?fields=user_id,username,name,profile_picture_url`, { headers: bearer(requireSecret(credentials, 'accessToken')) })
    return [{ platform: 'instagram', remoteId: requiredString(data.user_id || data.id), displayName: data.name || requiredString(data.username),
      profileUrl: `https://www.instagram.com/${encodeURIComponent(data.username)}/`, pictureUrl: publicHttpsUrl(data.profile_picture_url), metadata: { username: data.username }, credentials }]
  },
  async refresh(ctx, account) {
    const url = new URL('https://graph.instagram.com/refresh_access_token')
    url.search = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: requireSecret(account, 'accessToken') }).toString()
    const { data } = await nativeRequest<{ access_token: string; expires_in: number }>(ctx, url)
    return tokenCredentials(data, ctx.now())
  },
  async publish(ctx, input) {
    if (!input.media.length || input.media.length > 10) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const token = requireSecret(input.account, 'accessToken')
    const headers = bearer(token)
    const base = `${instagram()}/${encodeURIComponent(input.account.remoteId)}`
    const multiple = input.media.length > 1
    if (multiple && input.media.some((item) => item.mime.startsWith('video/'))) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const children: string[] = []
    for (const media of input.media) {
      const video = media.mime.startsWith('video/')
      if (!video && !media.mime.startsWith('image/')) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
      const url = await ctx.publicMediaUrl(media, { jpeg: !video })
      const body = { ...(video ? { media_type: stringSetting(input.settings, 'post_type') === 'story' ? 'STORIES' : 'REELS', video_url: url } : { image_url: url }),
        ...(multiple ? { is_carousel_item: true } : { caption: input.text }), ...(media.altText && !video ? { alt_text: media.altText } : {}) }
      const { data } = await nativeRequest<{ id: string }>(ctx, `${base}/media`, { method: 'POST', headers, body })
      children.push(requiredString(data.id))
    }
    let container = children[0]
    if (multiple) {
      const { data } = await nativeRequest<{ id: string }>(ctx, `${base}/media`, { method: 'POST', headers, body: { media_type: 'CAROUSEL', children: children.join(','), caption: input.text } })
      container = requiredString(data.id)
    }
    await readyContainer(ctx, token, container)
    const { data } = await nativeRequest<{ id: string }>(ctx, `${base}/media_publish`, { method: 'POST', headers, body: { creation_id: container }, write: true })
    const id = publishedId(data?.id)
    // A missing optional permalink does not discard a successful remote write.
    let remoteUrl: string | undefined
    try {
      const { data: record } = await nativeRequest<{ permalink?: string }>(ctx, `${instagram()}/${encodeURIComponent(id)}?fields=permalink`, { headers })
      remoteUrl = publicHttpsUrl(record.permalink)
    } catch { /* The durable remote ID still proves publication. */ }
    return { remoteId: id, remoteUrl, status: 'published' }
  },
}
