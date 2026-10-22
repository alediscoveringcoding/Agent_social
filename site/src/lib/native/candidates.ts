import 'server-only'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { callRpc } from '../social/server/run-admin-action.ts'
import { openCredentials, sealCredentials } from './credentials.ts'
import { accountCredentialContext } from './server.ts'
import type { NativeAccount } from './types.ts'

export interface CandidateSummary { index: number; displayName: string; profileUrl: string | null; platform: string }
export async function storeNativeCandidates(admin: SupabaseClient, actorId: string, brandId: string, accounts: NativeAccount[]): Promise<string> {
  if (!accounts.length || accounts.length > 100 || accounts.some((account) => account.platform !== accounts[0].platform)) throw new Error('NATIVE_NO_DESTINATIONS')
  const id = randomUUID()
  const secrets = Object.fromEntries(accounts.map((account, index) => [`candidate${index}`, JSON.stringify(account)]))
  // Keep the existing envelope's limit of 32 secret fields, without silently
  // omitting destinations on accounts which manage many Pages.
  const chunks: Record<string, string> = {}
  const entries = Object.entries(secrets)
  for (let i = 0; i < entries.length; i += 4) chunks[`batch${i / 4}`] = JSON.stringify(entries.slice(i, i + 4).map(([, value]) => value))
  const destinations: CandidateSummary[] = accounts.map((account, index) => ({ index, displayName: account.displayName, profileUrl: account.profileUrl ?? null, platform: account.platform }))
  await callRpc(admin, 'social_native_candidates_store', { p_id: id, p_actor: actorId, p_brand: brandId, p_platform: accounts[0].platform,
    p_encrypted: sealCredentials({ secrets: chunks }, `candidates:${id}`), p_destinations: destinations })
  return id
}
export async function connectNativeCandidate(admin: SupabaseClient, actorId: string, id: string, index: number): Promise<string> {
  const saved = await callRpc<{ encrypted: string; brand_id: string; platform: string }>(admin, 'social_native_candidates_consume', { p_id: id, p_actor: actorId })
  const chunks = openCredentials(saved.encrypted, `candidates:${id}`).secrets
  const batch = JSON.parse(chunks[`batch${Math.floor(index / 4)}`] || '[]') as string[]
  const account = JSON.parse(batch[index % 4] || 'null') as NativeAccount | null
  if (!account || account.platform !== saved.platform) throw new Error('NATIVE_DESTINATION_INVALID')
  const instance = typeof account.metadata.instanceUrl === 'string' ? account.metadata.instanceUrl : ''
  return callRpc<string>(admin, 'social_native_connect', {
    p_platform: account.platform, p_remote_id: account.remoteId, p_instance_url: instance,
    p_name: account.displayName.slice(0, 120), p_profile_url: account.profileUrl ?? null, p_picture_url: account.pictureUrl ?? null,
    p_brand: saved.brand_id, p_encrypted: sealCredentials(account.credentials, accountCredentialContext(account.platform, account.remoteId, instance)),
    p_metadata: account.metadata, p_expires_at: account.credentials.expiresAt ?? null, p_actor: actorId,
  })
}
