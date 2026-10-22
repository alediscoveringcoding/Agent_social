import 'server-only'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { callRpc } from '../social/server/run-admin-action.ts'
import { sealCredentials } from './credentials.ts'
import { NativeProviderError } from './http.ts'
import type { NativeAccount, NativeContext, NativeProvider } from './types.ts'

export async function refreshNativeAccount(admin: SupabaseClient, accountId: string, workerId: string, version: number,
  account: NativeAccount, provider: NativeProvider, ctx: NativeContext, context: string): Promise<NativeAccount> {
  const expiry = account.credentials.expiresAt
  if (!expiry || Date.parse(expiry) > ctx.now().getTime() + 120_000) return account
  if (!provider.refresh) throw new NativeProviderError('AUTH_EXPIRED', 401, false)
  const owner = randomUUID()
  const claimed = await callRpc<boolean>(admin, 'social_native_refresh_claim', { p_account: accountId, p_version: version, p_owner: owner, p_worker_id: workerId })
  if (!claimed) throw new NativeProviderError('TEMPORARY_FAILURE', 0, false, 120)
  let updated
  try { updated = await provider.refresh(ctx, account) }
  catch {
    await callRpc(admin, 'social_native_refresh_finish', { p_account: accountId, p_version: version, p_owner: owner,
      p_worker_id: workerId, p_encrypted: null, p_expires_at: null, p_error_code: 'AUTH_EXPIRED' })
    throw new NativeProviderError('AUTH_EXPIRED', 401, false)
  }
  const saved = await callRpc<boolean>(admin, 'social_native_refresh_finish', { p_account: accountId, p_version: version, p_owner: owner,
    p_worker_id: workerId, p_encrypted: sealCredentials(updated, context), p_expires_at: updated.expiresAt ?? null, p_error_code: null })
  if (!saved) throw new NativeProviderError('TEMPORARY_FAILURE', 0, false, 120)
  return { ...account, credentials: updated }
}
