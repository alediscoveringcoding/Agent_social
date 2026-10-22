import { nativeRequest, NativeProviderError, NativeProcessingFailedError } from '../http.ts'
import { requireSecret, stringSetting, type NativeProvider } from '../types.ts'
import { accountInstance, instanceUrl, publishedId, requestedDestination, requiredString, titleOf } from './shared.ts'
import { markdownToHtml, markdownToPlain } from '../../social/handoff.ts'

const headers = (user: string, token: string) => ({ authorization: `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}` })
/** https://listmonk.app/docs/apis/campaigns/ */
export const listmonkProvider: NativeProvider = {
  platform: 'listmonk',
  async connect(ctx, input) {
    const instance = instanceUrl(input.instanceUrl); const id = requestedDestination(input)
    if (!/^[1-9]\d*$/.test(id)) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const user = requireSecret(input.credentials, 'username'); const token = requireSecret(input.credentials, 'apiToken')
    const from = requireSecret(input.credentials, 'fromEmail')
    if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from)) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const { data } = await nativeRequest<{ data: { id: number; name: string } }>(ctx, `${instance}/api/lists/${id}`, { headers: headers(user, token) })
    if (String(data.data?.id) !== id) throw new NativeProviderError('PERMISSION_DENIED', 403, false)
    return [{ platform: 'listmonk', remoteId: id, displayName: requiredString(data.data.name), metadata: { instanceUrl: instance, fromEmail: from },
      credentials: { secrets: { username: user, apiToken: token } } }]
  },
  async publish(ctx, input) {
    if (stringSetting(input.settings, 'list') !== input.account.remoteId || input.media.length) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const instance = accountInstance(input.account); const auth = headers(requireSecret(input.account, 'username'), requireSecret(input.account, 'apiToken'))
    const template = stringSetting(input.settings, 'template')
    const content = [stringSetting(input.settings, 'subtitle'), input.text].filter(Boolean).join('\n\n')
    const { data } = await nativeRequest<{ data: { id: number; uuid: string } }>(ctx, `${instance}/api/campaigns`, { method: 'POST', headers: auth,
      body: { name: `Social ${input.jobId}`, subject: titleOf(input), from_email: input.account.metadata.fromEmail, body: markdownToHtml(content), altbody: markdownToPlain(content),
        content_type: 'html', type: 'regular', messenger: 'email', lists: [Number(input.account.remoteId)], ...(template ? { template_id: Number(template) } : {}) } })
    const id = requiredString(data.data?.id)
    const publication = { remoteId: id, status: 'processing' as const, metadata: { campaignUuid: requiredString(data.data.uuid) } }
    await ctx.checkpoint?.(publication)
    await nativeRequest(ctx, `${instance}/api/campaigns/${id}/status`, { method: 'PUT', headers: auth, body: { status: 'running' }, write: true })
    return publication
  },
  async poll(ctx, account, publication) {
    const { data } = await nativeRequest<{ data: { id: number; status: string } }>(ctx, `${accountInstance(account)}/api/campaigns/${encodeURIComponent(publication.remoteId)}`,
      { headers: headers(requireSecret(account, 'username'), requireSecret(account, 'apiToken')) })
    if (!data.data || String(data.data.id) !== publication.remoteId) throw new NativeProviderError('UNKNOWN_RESULT', 404, true)
    if (data.data.status === 'cancelled') throw new NativeProcessingFailedError()
    return data.data.status === 'finished' ? { ...publication, remoteId: publishedId(data.data.id), status: 'published' } : publication
  },
}
