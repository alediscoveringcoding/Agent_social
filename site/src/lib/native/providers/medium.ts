import { bearer, nativeRequest, NativeProviderError } from '../http.ts'
import { requireSecret, stringSetting, type NativeProvider } from '../types.ts'
import { mediaBlob, publicHttpsUrl, publishedId, requiredString, tagsOf, titleOf } from './shared.ts'

const BASE = 'https://api.medium.com/v1'
/** Legacy API, explicitly unsupported upstream: https://github.com/Medium/medium-api-docs */
export const mediumProvider: NativeProvider = {
  platform: 'medium',
  async connect(ctx, input) {
    const token = requireSecret(input.credentials, 'accessToken')
    const { data } = await nativeRequest<{ data: { id: string; name: string; username: string; url: string; imageUrl?: string } }>(ctx,
      `${BASE}/me`, { headers: bearer(token) })
    const user = data.data
    return [{ platform: 'medium', remoteId: requiredString(user?.id), displayName: requiredString(user?.name || user?.username),
      profileUrl: publicHttpsUrl(user?.url), pictureUrl: publicHttpsUrl(user?.imageUrl), metadata: { legacyApi: true }, credentials: { secrets: { accessToken: token } } }]
  },
  async publish(ctx, input) {
    if (input.media.some(media => !['image/png', 'image/jpeg'].includes(media.mime))) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const title = titleOf(input)
    const subtitle = stringSetting(input.settings, 'subtitle')
    let content = `# ${title}\n\n${subtitle ? `${subtitle}\n\n` : ''}${input.text}`
    for (const media of input.media) {
      const form = new FormData(); form.set('image', await mediaBlob(ctx, media), media.filename)
      const { data } = await nativeRequest<{ data: { url: string } }>(ctx, `${BASE}/images`, { method: 'POST', headers: bearer(requireSecret(input.account, 'accessToken')), body: form })
      const url = publicHttpsUrl(data.data?.url)
      if (!url) throw new NativeProviderError('INVALID_RESPONSE', 200, false)
      content += `\n\n![${media.altText.replace(/[\[\]\\]/g, '\\$&')}](${url})`
    }
    const { data } = await nativeRequest<{ data: { id: string; url: string } }>(ctx,
      `${BASE}/users/${encodeURIComponent(input.account.remoteId)}/posts`, {
        method: 'POST', headers: bearer(requireSecret(input.account, 'accessToken')), write: true,
        body: { title, contentFormat: 'markdown', content, publishStatus: 'public', tags: tagsOf(input.settings).slice(0, 3),
          ...(stringSetting(input.settings, 'canonical_url') ? { canonicalUrl: stringSetting(input.settings, 'canonical_url') } : {}) },
      })
    return { remoteId: publishedId(data?.data?.id), remoteUrl: publicHttpsUrl(data?.data?.url), status: 'published' }
  },
}
