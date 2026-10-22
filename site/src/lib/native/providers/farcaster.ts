import { nativeRequest, NativeProviderError } from '../http.ts'
import { requireSecret, stringSetting, type NativeProvider } from '../types.ts'
import { publicHttpsUrl, publishedId, requiredString } from './shared.ts'

const BASE = 'https://api.neynar.com/v2/farcaster'
/** https://docs.neynar.com/reference/publish-cast */
export const farcasterProvider: NativeProvider = {
  platform: 'farcaster',
  async connect(ctx, input) {
    const key = requireSecret(input.credentials, 'apiKey'); const signer = requireSecret(input.credentials, 'signerUuid')
    const headers = { 'x-api-key': key }
    const { data } = await nativeRequest<{ status: string; fid: number }>(ctx, `${BASE}/signer/?signer_uuid=${encodeURIComponent(signer)}`, { headers })
    if (data.status !== 'approved' || !Number.isSafeInteger(data.fid) || data.fid <= 0) throw new NativeProviderError('PERMISSION_DENIED', 403, false)
    const { data: profile } = await nativeRequest<{ users: Array<{ fid: number; username: string; display_name?: string; pfp_url?: string }> }>(ctx, `${BASE}/user/bulk/?fids=${data.fid}`, { headers })
    const user = profile.users?.find(item => item.fid === data.fid)
    if (!user) throw new NativeProviderError('INVALID_RESPONSE', 200, false)
    return [{ platform: 'farcaster', remoteId: String(data.fid), displayName: user.display_name || requiredString(user.username),
      profileUrl: `https://farcaster.xyz/${encodeURIComponent(user.username)}`, pictureUrl: publicHttpsUrl(user.pfp_url), metadata: { username: user.username }, credentials: { secrets: { apiKey: key, signerUuid: signer } } }]
  },
  async publish(ctx, input) {
    if (input.media.length) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
    const { data } = await nativeRequest<{ cast: { hash: string } }>(ctx, `${BASE}/cast/`, { method: 'POST', headers: { 'x-api-key': requireSecret(input.account, 'apiKey') },
      body: { signer_uuid: requireSecret(input.account, 'signerUuid'), text: input.text, idem: input.jobId,
        ...(stringSetting(input.settings, 'channel') ? { channel_id: stringSetting(input.settings, 'channel') } : {}) }, write: true })
    const id = publishedId(data.cast?.hash)
    const username = input.account.metadata.username
    return { remoteId: id, remoteUrl: typeof username === 'string' ? `https://farcaster.xyz/${encodeURIComponent(username)}/${encodeURIComponent(id)}` : undefined, status: 'published' }
  },
}
