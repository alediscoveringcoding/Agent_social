import { bearer, nativeRequest, NativeProviderError } from '../http.ts'
import { oauthConfig } from '../oauth-config.ts'
import { refreshOAuthToken } from '../oauth.ts'
import { requireSecret, type NativeAccount, type NativeContext, type NativeProvider } from '../types.ts'
import { mediaBlob, publishedId, publicHttpsUrl, requiredString } from './shared.ts'

const BASE = 'https://api.linkedin.com'
function headers(token: string) {
  const version = process.env.LINKEDIN_API_VERSION || '202610'
  if (!/^20\d{2}(0[1-9]|1[0-2])$/.test(version)) throw new Error('NATIVE_LINKEDIN_VERSION_INVALID')
  return { ...bearer(token), 'LinkedIn-Version': version, 'X-Restli-Protocol-Version': '2.0.0' }
}
function author(account: NativeAccount): string {
  return account.platform === 'linkedin-page' ? `urn:li:organization:${account.remoteId}` : `urn:li:person:${account.remoteId}`
}
async function uploadImage(ctx: NativeContext, input: Parameters<NativeProvider['publish']>[1], index: number) {
  const media = input.media[index]
  const auth = headers(requireSecret(input.account, 'accessToken'))
  const { data } = await nativeRequest<{ value: { image: string; uploadUrl: string } }>(ctx, `${BASE}/rest/images?action=initializeUpload`, {
    method: 'POST', headers: auth, body: { initializeUploadRequest: { owner: author(input.account) } },
  })
  const url = new URL(requiredString(data.value?.uploadUrl))
  if (url.protocol !== 'https:' || !(url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com'))) throw new NativeProviderError('INVALID_RESPONSE', 200, false)
  await nativeRequest(ctx, url, { method: 'PUT', headers: { ...auth, 'content-type': media.mime }, body: await mediaBlob(ctx, media), timeoutMs: 120_000 })
  return { id: requiredString(data.value.image), altText: media.altText }
}
function provider(platform: 'linkedin' | 'linkedin-page'): NativeProvider {
  return {
    platform,
    async connect(ctx, input) {
      const token = requireSecret(input.credentials, 'accessToken')
      if (platform === 'linkedin') {
        const { data } = await nativeRequest<{ sub: string; name: string; picture?: string }>(ctx, `${BASE}/v2/userinfo`, { headers: bearer(token) })
        return [{ platform, remoteId: requiredString(data.sub), displayName: requiredString(data.name), pictureUrl: publicHttpsUrl(data.picture), metadata: {}, credentials: input.credentials }]
      }
      const accounts: NativeAccount[] = []
      for (let start = 0; start < 1000; start += 100) {
        const { data } = await nativeRequest<{ elements: Array<{ organization: string; role: string; state: string }> }>(ctx,
          `${BASE}/rest/organizationAcls?q=roleAssignee&state=APPROVED&start=${start}&count=100`, { headers: headers(token) })
        for (const role of data.elements ?? []) {
          if (!['ADMINISTRATOR', 'CONTENT_ADMIN'].includes(role.role) || role.state !== 'APPROVED') continue
          const id = /^urn:li:organization:(\d+)$/.exec(role.organization)?.[1]
          if (!id || accounts.some((item) => item.remoteId === id)) continue
          const { data: organization } = await nativeRequest<{ localizedName: string; vanityName?: string }>(ctx, `${BASE}/rest/organizations/${id}`, { headers: headers(token) })
          accounts.push({ platform, remoteId: id, displayName: requiredString(organization.localizedName),
            profileUrl: `https://www.linkedin.com/company/${encodeURIComponent(organization.vanityName || id)}/`, metadata: {}, credentials: input.credentials })
        }
        if ((data.elements?.length ?? 0) < 100) break
      }
      return accounts
    },
    refresh: (ctx, account) => refreshOAuthToken(ctx, oauthConfig(platform), account.credentials),
    async publish(ctx, input) {
      if (input.media.length > 20 || input.media.some((item) => !item.mime.startsWith('image/'))) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
      const images = []
      for (let i = 0; i < input.media.length; i++) images.push(await uploadImage(ctx, input, i))
      const body = { author: author(input.account), commentary: input.text, visibility: 'PUBLIC',
        distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] }, lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
        ...(images.length === 1 ? { content: { media: images[0] } } : images.length ? { content: { multiImage: { images } } } : {}),
      }
      const { response } = await nativeRequest(ctx, `${BASE}/rest/posts`, { method: 'POST', headers: headers(requireSecret(input.account, 'accessToken')), body, write: true })
      const id = publishedId(response.headers.get('x-restli-id'))
      return { remoteId: id, remoteUrl: `https://www.linkedin.com/feed/update/${encodeURIComponent(id)}/`, status: 'published' }
    },
  }
}
/** https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api */
export const linkedinProvider = provider('linkedin')
export const linkedinPageProvider = provider('linkedin-page')
