import { nativeRequest, NativeProviderError } from '../http.ts'
import { requireSecret, stringSetting, type NativeContext, type NativeProvider } from '../types.ts'
import { publicHttpsUrl, publishedId, requestedDestination, requiredString, tagsOf, titleOf } from './shared.ts'

const BASE = 'https://api.stackexchange.com/2.3'
async function api<T>(ctx: NativeContext, path: string, form: URLSearchParams, write = false): Promise<T[]> {
  const { data } = await nativeRequest<{ items?: T[]; error_id?: number; error_name?: string; backoff?: number }>(ctx,
    write ? `${BASE}${path}` : `${BASE}${path}?${form}`, { ...(write ? { method: 'POST', body: form } : {}), write })
  if (data?.error_id) {
    if (['access_token_required', 'access_token_invalid', 'access_token_compromised'].includes(data.error_name || '')) throw new NativeProviderError('AUTH_EXPIRED', 401, false)
    if (data.error_name === 'access_denied') throw new NativeProviderError('PERMISSION_DENIED', 403, false)
    if (data.error_name === 'throttle_violation') throw new NativeProviderError('RATE_LIMITED', 429, false, data.backoff || 60)
    if (data.error_name === 'internal_error') throw new NativeProviderError(write ? 'UNKNOWN_RESULT' : 'TEMPORARY_FAILURE', 502, write)
    throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
  }
  if (!data?.items?.length) throw new NativeProviderError(write ? 'UNKNOWN_RESULT' : 'INVALID_RESPONSE', 200, write)
  return data.items
}
/** https://api.stackexchange.com/docs/create-answer */
export const stackexchangeProvider: NativeProvider = {
  platform: 'stackexchange',
  async connect(ctx, input) {
    const site = requestedDestination(input).toLowerCase()
    if (!/^[a-z0-9.-]+$/.test(site)) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const token = requireSecret(input.credentials, 'accessToken'); const key = requireSecret(input.credentials, 'apiKey')
    const [user] = await api<{ user_id: number; display_name: string; link: string }>(ctx, '/me', new URLSearchParams({ site, access_token: token, key }))
    const profile = publicHttpsUrl(user.link)
    if (!profile) throw new NativeProviderError('INVALID_RESPONSE', 200, false)
    const host = new URL(profile).hostname
    if (!['stackoverflow.com', 'stackexchange.com', 'superuser.com', 'serverfault.com', 'askubuntu.com', 'mathoverflow.net'].some(domain => host === domain || host.endsWith(`.${domain}`))) throw new NativeProviderError('INVALID_RESPONSE', 200, false)
    return [{ platform: 'stackexchange', remoteId: `${host}:${requiredString(user.user_id)}`, displayName: `${requiredString(user.display_name)} / ${host}`,
      profileUrl: profile, metadata: { site: host }, credentials: { secrets: { accessToken: token, apiKey: key } } }]
  },
  async publish(ctx, input) {
    const site = requiredString(input.account.metadata.site)
    if (stringSetting(input.settings, 'site', 'money.stackexchange.com') !== site) throw new NativeProviderError('PERMISSION_DENIED', 403, false)
    if (input.media.length) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const body = input.text
    const form = new URLSearchParams({ site, access_token: requireSecret(input.account, 'accessToken'), key: requireSecret(input.account, 'apiKey'), body })
    if (stringSetting(input.settings, 'post_type', 'answer') === 'answer') {
      const url = new URL(stringSetting(input.settings, 'question_url'))
      const question = /^\/(?:questions|q)\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1]
      if (url.protocol !== 'https:' || url.hostname !== site || !question) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
      const [sent] = await api<{ answer_id: number }>(ctx, `/questions/${question}/answers/add`, form, true)
      const id = publishedId(sent.answer_id)
      return { remoteId: id, remoteUrl: `https://${site}/a/${id}`, status: 'published' }
    }
    form.set('title', titleOf(input)); form.set('tags', tagsOf(input.settings).join(';'))
    const [sent] = await api<{ question_id: number }>(ctx, '/questions/add', form, true)
    const id = publishedId(sent.question_id)
    return { remoteId: id, remoteUrl: `https://${site}/q/${id}`, status: 'published' }
  },
}
