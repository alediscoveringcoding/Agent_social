import { bearer, nativeRequest, NativeProviderError } from '../http.ts'
import { requireSecret, stringSetting, type NativeContext, type NativeProvider } from '../types.ts'
import { mediaBlob, publicHttpsUrl, publishedId, requestedDestination, requiredString } from './shared.ts'

interface Result { ok: boolean; error?: string }
async function slack<T extends Result>(ctx: NativeContext, token: string, method: string, body: Record<string, unknown>, write = false): Promise<T> {
  const form = new URLSearchParams(Object.entries(body).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]))
  const { data } = await nativeRequest<T>(ctx, `https://slack.com/api/${method}`, { method: 'POST', headers: bearer(token), body: form, write })
  if (!data?.ok) {
    const code = data?.error || ''
    if (['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive'].includes(code)) throw new NativeProviderError('AUTH_EXPIRED', 401, false)
    if (['missing_scope', 'no_permission', 'not_in_channel', 'channel_not_found', 'is_archived'].includes(code)) throw new NativeProviderError('PERMISSION_DENIED', 403, false)
    if (['ratelimited', 'rate_limited'].includes(code)) throw new NativeProviderError('RATE_LIMITED', 429, false, 60)
    if (!code || ['fatal_error', 'internal_error', 'request_timeout', 'service_unavailable'].includes(code)) throw new NativeProviderError(write ? 'UNKNOWN_RESULT' : 'TEMPORARY_FAILURE', 502, write)
    throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
  }
  return data
}
/** https://docs.slack.dev/reference/methods/chat.postMessage/ */
export const slackProvider: NativeProvider = {
  platform: 'slack',
  async connect(ctx, input) {
    const token = requireSecret(input.credentials, 'accessToken'); const id = requestedDestination(input)
    if (!/^[CG][A-Z0-9]+$/.test(id)) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const auth = await slack<Result & { user_id: string; team_id: string; team: string }>(ctx, token, 'auth.test', {})
    const info = await slack<Result & { channel: { id: string; name: string; is_archived?: boolean } }>(ctx, token, 'conversations.info', { channel: id })
    if (info.channel?.id !== id || info.channel.is_archived) throw new NativeProviderError('PERMISSION_DENIED', 403, false)
    return [{ platform: 'slack', remoteId: id, displayName: `${requiredString(auth.team)} / #${requiredString(info.channel.name)}`,
      profileUrl: `https://app.slack.com/client/${encodeURIComponent(auth.team_id)}/${id}`, metadata: { teamId: auth.team_id, userId: auth.user_id }, credentials: { secrets: { accessToken: token } } }]
  },
  async publish(ctx, input) {
    const token = requireSecret(input.account, 'accessToken'); const channel = input.account.remoteId
    const selected = stringSetting(input.settings, 'channel')
    if ((selected && selected !== channel) || input.media.length > 10 || input.media.some(media => !media.mime.startsWith('image/'))) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    if (input.media.length) {
      const files: Array<{ id: string; title: string }> = []
      for (const media of input.media) {
        const upload = await slack<Result & { upload_url: string; file_id: string }>(ctx, token, 'files.getUploadURLExternal', { filename: media.filename, length: media.bytes, alt_txt: media.altText })
        const url = new URL(requiredString(upload.upload_url))
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.slack.com') || url.username || url.password) throw new NativeProviderError('INVALID_RESPONSE', 200, false)
        await nativeRequest(ctx, url, { method: 'POST', body: await mediaBlob(ctx, media), responseType: 'text', timeoutMs: 120_000 })
        files.push({ id: requiredString(upload.file_id), title: media.altText })
      }
      const sent = await slack<Result & { files: Array<{ id: string; permalink?: string }> }>(ctx, token, 'files.completeUploadExternal', { files, channel_id: channel, initial_comment: input.text }, true)
      return { remoteId: publishedId(sent.files?.[0]?.id), remoteUrl: publicHttpsUrl(sent.files?.[0]?.permalink), status: 'published' }
    }
    const sent = await slack<Result & { ts: string }>(ctx, token, 'chat.postMessage', { channel, text: input.text, mrkdwn: false, client_msg_id: input.jobId }, true)
    const id = publishedId(sent.ts)
    let remoteUrl: string | undefined
    try { const link = await slack<Result & { permalink: string }>(ctx, token, 'chat.getPermalink', { channel, message_ts: id }); remoteUrl = publicHttpsUrl(link.permalink) } catch { /* The write has already succeeded. */ }
    return { remoteId: id, remoteUrl, status: 'published' }
  },
}
