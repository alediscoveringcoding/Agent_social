import { bearer, nativeRequest, NativeProviderError } from '../http.ts'
import { requireSecret, stringSetting, type NativeProvider } from '../types.ts'
import { accountInstance, instanceUrl, publicHttpsUrl, publishedId, requestedDestination, requiredString, titleOf } from './shared.ts'

interface Person { id: number; name: string; display_name?: string; banned?: boolean; deleted?: boolean; actor_id?: string; ap_id?: string }
interface User { local_user_view: { person: Person } }
/** https://join-lemmy.org/docs/contributors/09-api-v4.html */
export const lemmyProvider: NativeProvider = {
  platform: 'lemmy',
  async connect(ctx, input) {
    const instance = instanceUrl(input.instanceUrl); const communityId = requestedDestination(input)
    if (!/^[1-9]\d*$/.test(communityId)) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const body = { username_or_email: requireSecret(input.credentials, 'username'), password: requireSecret(input.credentials, 'password'),
      ...(input.credentials.secrets.totp ? { totp_2fa_token: input.credentials.secrets.totp } : {}) }
    let version = 4
    let jwt: string
    try { const result = await nativeRequest<{ jwt?: string }>(ctx, `${instance}/api/v4/account/auth/login`, { method: 'POST', body }); jwt = requiredString(result.data.jwt) }
    catch (error) {
      if (!(error instanceof NativeProviderError) || error.status !== 404) throw error
      version = 3
      const result = await nativeRequest<{ jwt?: string }>(ctx, `${instance}/api/v3/user/login`, { method: 'POST', body }); jwt = requiredString(result.data.jwt)
    }
    const headers = bearer(jwt)
    const profile = version === 4 ? (await nativeRequest<User>(ctx, `${instance}/api/v4/account`, { headers })).data :
      (await nativeRequest<{ my_user: User }>(ctx, `${instance}/api/v3/site`, { headers })).data.my_user
    const person = profile?.local_user_view?.person
    if (!person || person.banned || person.deleted) throw new NativeProviderError('PERMISSION_DENIED', 403, false)
    const { data } = await nativeRequest<{ community_view: { community: { id: number; name: string; removed: boolean; deleted: boolean }; banned_from_community?: boolean } }>(ctx,
      `${instance}/api/v${version}/community?id=${communityId}`, { headers })
    const view = data.community_view
    if (String(view?.community?.id) !== communityId || view.community.removed || view.community.deleted || view.banned_from_community) throw new NativeProviderError('PERMISSION_DENIED', 403, false)
    return [{ platform: 'lemmy', remoteId: `${requiredString(person.id)}:${communityId}`, displayName: `${person.display_name || person.name} / ${view.community.name}`,
      profileUrl: publicHttpsUrl(person.ap_id || person.actor_id) || `${instance}/u/${encodeURIComponent(person.name)}`,
      metadata: { instanceUrl: instance, apiVersion: version, communityId, communityName: view.community.name }, credentials: { secrets: { accessToken: jwt } } }]
  },
  async publish(ctx, input) {
    const id = requiredString(input.account.metadata.communityId)
    if (stringSetting(input.settings, 'community_id') !== id || stringSetting(input.settings, 'community') !== input.account.metadata.communityName || input.media.length) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const version = input.account.metadata.apiVersion
    if (version !== 3 && version !== 4) throw new NativeProviderError('SETUP_REQUIRED', 0, false)
    const url = stringSetting(input.settings, 'link')
    const { data } = await nativeRequest<{ post_view: { post: { id: number; ap_id?: string; actor_id?: string } } }>(ctx, `${accountInstance(input.account)}/api/v${version}/post`, {
      method: 'POST', headers: bearer(requireSecret(input.account, 'accessToken')), write: true,
      body: { name: titleOf(input), community_id: Number(id), body: input.text, ...(url ? { url } : {}) },
    })
    const remoteId = publishedId(data.post_view?.post?.id)
    return { remoteId, remoteUrl: publicHttpsUrl(data.post_view.post.ap_id || data.post_view.post.actor_id) || `${accountInstance(input.account)}/post/${remoteId}`, status: 'published' }
  },
}
