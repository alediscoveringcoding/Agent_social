import 'server-only'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SOCIAL_BUCKET } from '../social/constants.ts'
import { destinationHash, sha256OfBytes } from '../social/hash.ts'
import { callRpc } from '../social/server/run-admin-action.ts'
import { publishingEnabled } from '../social/server/worker-http.ts'
import { credentialContext, openCredentials, sealCredentials } from './credentials.ts'
import { NativeProviderError, NativeProcessingFailedError } from './http.ts'
import { nativeFetch } from './network.ts'
import { nativeProvider } from './providers/index.ts'
import { refreshNativeAccount } from './refresh.ts'
import { instanceUrl } from './providers/shared.ts'
import type { JsonObject, NativeAccount, NativeContext, NativeMedia, NativePublication, NativeProvider, NativePublishInput } from './types.ts'

export function accountCredentialContext(platform: string, remoteId: string, instance: string): string {
  return credentialContext(platform, createHash('sha256').update(JSON.stringify([instance, remoteId])).digest('hex'))
}

interface MediaRow { id: string; mime: string; bytes: number; sha256: string; width: number; height: number; storage_path: string; duration_seconds?: number | null }
interface LinkRow { alt_text: string; media: MediaRow | null }
interface JobRow { id: string; account_id: string; destination_id: string; status: string; attempts: number; lease_owner: string | null; lease_expires_at: string | null }
interface PublicationRow { job_id: string; state: 'publishing' | 'processing' | 'published' | 'rejected' | 'unknown'; remote_id: string | null; remote_url: string | null; metadata: JsonObject; error_code: string | null; retry_after_seconds: number | null; publisher_nonce?: string }
interface Transition { ok: boolean; http?: number; code?: string; message?: string; status?: string }
interface BeginResult extends Transition { send: boolean; publication: PublicationRow & { idempotency_key: string } }

function must<T>(result: { data: unknown; error: unknown }): T {
  if (result.error) throw new Error('NATIVE_DATABASE_FAILED')
  return result.data as T
}

export function nativeContext(admin: SupabaseClient, mediaRows: MediaRow[] = [], network: typeof fetch = nativeFetch): NativeContext {
  const records = new Map(mediaRows.map((row) => [row.id, row]))
  const cache = new Map<string, Uint8Array>()
  return {
    fetch: network, now: () => new Date(),
    async readMedia(media) {
      const row = records.get(media.id)
      if (!row || row.sha256 !== media.sha256) throw new Error('NATIVE_MEDIA_NOT_ATTACHED')
      const cached = cache.get(row.id)
      if (cached) return cached
      const { data, error } = await admin.storage.from(SOCIAL_BUCKET).download(row.storage_path)
      if (error || !data) throw new Error('NATIVE_MEDIA_FETCH_FAILED')
      const bytes = new Uint8Array(await data.arrayBuffer())
      if (bytes.byteLength !== Number(row.bytes) || sha256OfBytes(bytes) !== row.sha256) throw new Error('NATIVE_MEDIA_HASH_MISMATCH')
      cache.set(row.id, bytes)
      return bytes
    },
    async publicMediaUrl(media, options) {
      const row = records.get(media.id)
      if (!row) throw new Error('NATIVE_MEDIA_NOT_ATTACHED')
      const { data, error } = await admin.storage.from(SOCIAL_BUCKET).createSignedUrl(row.storage_path, 3600)
      if (error || !data?.signedUrl) throw new NativeProviderError('SETUP_REQUIRED', 0, false)
      const url = new URL(data.signedUrl, process.env.PUBLIC_SITE_BASE_URL || process.env.SITE_BASE_URL || 'http://localhost:3000')
      try { instanceUrl(`${url.origin}${url.pathname}`) }
      catch { throw new NativeProviderError('SETUP_REQUIRED', 0, false) }
      if (options?.jpeg && row.mime !== 'image/jpeg') {
        const { signedMediaUrl } = await import('../social/media/signing.ts')
        const transformed = new URL(signedMediaUrl(row.id), process.env.PUBLIC_SITE_BASE_URL || process.env.SITE_BASE_URL || 'http://localhost:3000')
        try { instanceUrl(`${transformed.origin}${transformed.pathname}`) }
        catch { throw new NativeProviderError('SETUP_REQUIRED', 0, false) }
        transformed.pathname = `/api/native/media/${row.id}`
        return transformed.href
      }
      return url.href
    },
  }
}

export async function loadNativeAccount(admin: SupabaseClient, accountId: string): Promise<NativeAccount & { credentialVersion: number }> {
  const account = must<{ platform: NativeAccount['platform']; native_provider_account_id: string; native_instance_url: string; display_name: string; profile_url: string | null; picture_url: string | null } | null>(await admin.from('social_accounts')
    .select('platform,native_provider_account_id,native_instance_url,display_name,profile_url,picture_url')
    .eq('id', accountId).eq('publishing_backend', 'native').maybeSingle())
  const saved = must<{ encrypted: string; metadata: JsonObject; version: number } | null>(await admin.from('social_native_credentials').select('encrypted,metadata,version').eq('account_id', accountId).maybeSingle())
  if (!account || !saved) throw new NativeProviderError('AUTH_EXPIRED', 401, false)
  return {
    platform: account.platform, remoteId: account.native_provider_account_id, displayName: account.display_name, credentialVersion: saved.version,
    profileUrl: account.profile_url ?? undefined, pictureUrl: account.picture_url ?? undefined, metadata: saved.metadata,
    credentials: openCredentials(saved.encrypted, accountCredentialContext(account.platform, account.native_provider_account_id, account.native_instance_url)),
  }
}

// A 13-character sortable record key: 53-bit microseconds plus ten random bits.
// Persisted by begin_publication before use, so HTTP replays reuse the same key.
let lastRecordMicros = 0n
const recordClock = BigInt(randomBytes(2).readUInt16BE() & 1023)
export function nativeRecordKey(now = Date.now()): string {
  const micros = BigInt(Math.floor(now)) * 1_000n
  lastRecordMicros = micros > lastRecordMicros ? micros : lastRecordMicros + 1n
  let value = lastRecordMicros * 1_024n + recordClock
  const alphabet = '234567abcdefghijklmnopqrstuvwxyz'
  let key = ''
  for (let i = 0; i < 13; i++) { key = alphabet[Number(value & 31n)] + key; value >>= 5n }
  return key
}

export interface NativeDeliveryDependencies {
  context?: (admin: SupabaseClient, media: MediaRow[]) => NativeContext
  provider?: (platform: string) => NativeProvider
}

export async function nativeDelivery(
  admin: SupabaseClient, workerId: string, jobId: string, attemptNo: number,
  kind: 'publish' | 'check', deps: NativeDeliveryDependencies = {},
): Promise<Transition> {
  const job = must<JobRow | null>(await admin.from('social_delivery_jobs')
    .select('id,account_id,destination_id,status,attempts,lease_owner,lease_expires_at').eq('id', jobId).maybeSingle())
  if (!job) return { ok: false, http: 404, code: 'NOT_FOUND' }
  if (job.attempts !== attemptNo || job.lease_owner !== workerId || !job.lease_expires_at || Date.parse(job.lease_expires_at) <= Date.now() ||
      !(kind === 'publish' ? job.status === 'submitting' : ['submitted', 'reconciling'].includes(job.status))) {
    return { ok: false, http: 409, code: 'LEASE_LOST' }
  }
  const result = (outcome: string, errorCode?: string, url?: string, retryAfter?: number) => callRpc<Transition>(admin, 'social_job_result', {
    p_job: jobId, p_worker_id: workerId, p_attempt_no: attemptNo, p_outcome: outcome,
    p_remote_url: url ?? null, p_error_code: errorCode ?? null, p_error_message: errorCode ? `Publicare directa: ${errorCode}` : null,
    p_retry_after_seconds: retryAfter ?? null,
  })
  const wait = () => callRpc<Transition>(admin, 'social_native_wait', { p_job: jobId, p_worker_id: workerId, p_attempt_no: attemptNo })
  const existing = must<PublicationRow | null>(await admin.from('social_native_publications')
    .select('job_id,state,remote_id,remote_url,metadata,error_code,retry_after_seconds,publisher_nonce').eq('job_id', jobId).maybeSingle())
  const settle = async (publication: PublicationRow): Promise<Transition> => {
    if (publication.state === 'published') return result('published', undefined, publication.remote_url ?? undefined)
    if (publication.state === 'rejected') {
      const code = publication.error_code || 'VALIDATION_REJECTED'
      // A rejected attempt can be retried only before reconciliation. After a
      // crash, a person may retry the explicit rejection from the failed job.
      return result(kind === 'publish' && ['RATE_LIMITED', 'TEMPORARY_FAILURE'].includes(code) ? 'retry' : 'failed', code, undefined, publication.retry_after_seconds ?? undefined)
    }
    return wait()
  }
  if (kind === 'check') {
    // The job lock in begin forbids a late publish after this reconciliation
    // claim. No journal means no native network write was ever permitted.
    if (!existing) return result('not_found')
    if (['processing', 'unknown'].includes(existing.state) && existing.remote_id && existing.publisher_nonce) {
      try {
        let loaded = await loadNativeAccount(admin, job.account_id)
        const provider = (deps.provider ?? nativeProvider)(loaded.platform)
        const ctx = (deps.context ?? nativeContext)(admin, [])
        const instance = typeof loaded.metadata.instanceUrl === 'string' ? loaded.metadata.instanceUrl : ''
        loaded = { ...await refreshNativeAccount(admin, job.account_id, workerId, loaded.credentialVersion, loaded, provider, ctx,
          accountCredentialContext(loaded.platform, loaded.remoteId, instance)), credentialVersion: loaded.credentialVersion }
        if (provider.poll) {
          const privateEnvelope = existing.metadata._private
          const privateData = typeof privateEnvelope === 'string' ? openCredentials(privateEnvelope, `publication:${jobId}`).secrets : undefined
          const metadata = { ...existing.metadata }; delete metadata._private
          const updated = await provider.poll(ctx, loaded, { remoteId: existing.remote_id, remoteUrl: existing.remote_url ?? undefined, status: 'processing', metadata, privateData })
          const next = await persistPublication(admin, jobId, existing.publisher_nonce, updated)
          if (!next) return { ok: false, http: 409, code: 'LEASE_LOST' }
          return settle({ ...existing, state: updated.status, remote_id: updated.remoteId, remote_url: updated.remoteUrl ?? null })
        }
      } catch (error) {
        if (error instanceof NativeProcessingFailedError) {
          await callRpc(admin, 'social_native_finish_publication', { p_job: jobId, p_nonce: existing.publisher_nonce,
            p_state: 'rejected', p_remote_id: existing.remote_id, p_remote_url: existing.remote_url, p_metadata: existing.metadata,
            p_error_code: error.code, p_retry_after_seconds: null })
          return result('failed', error.code)
        }
      }
    }
    return settle(existing)
  }
  if (existing && existing.state !== 'rejected') return settle(existing)

  let account: NativeAccount
  let credentialVersion: number
  try { const loaded = await loadNativeAccount(admin, job.account_id); account = loaded; credentialVersion = loaded.credentialVersion }
  catch (error) {
    if (error instanceof NativeProviderError) return result('failed', error.code)
    throw error
  }
  let provider: NativeProvider
  try { provider = (deps.provider ?? nativeProvider)(account.platform) }
  catch { return result('failed', 'NATIVE_PROVIDER_UNAVAILABLE') }
  const destination = must<{ text: string; settings: JsonObject; scheduled_at: string; destination_hash: string }>(await admin.from('social_destinations')
    .select('text,settings,scheduled_at,destination_hash').eq('id', job.destination_id).single())
  const links = must<LinkRow[]>(await admin.from('social_destination_media')
    .select('alt_text,media:social_media(id,mime,bytes,sha256,width,height,storage_path,duration_seconds)').eq('destination_id', job.destination_id).order('position'))
  const media: NativeMedia[] = []
  for (const link of links) {
    if (!link.media) return result('failed', 'MEDIA_HASH_MISMATCH')
    media.push({ ...link.media, durationSeconds: link.media.duration_seconds ?? undefined, bytes: Number(link.media.bytes), altText: link.alt_text, filename: `${link.media.id}.${link.media.mime.split('/')[1] || 'bin'}` })
  }
  const hash = destinationHash({ account_id: job.account_id, platform: account.platform, text: destination.text,
    settings: destination.settings, scheduled_at: destination.scheduled_at, media: media.map((item) => ({ sha256: item.sha256, alt_text: item.altText })) })
  if (hash !== destination.destination_hash) return result('failed', 'HASH_MISMATCH')
  const ctx = (deps.context ?? nativeContext)(admin, links.map((item) => item.media!))
  try {
    const instance = typeof account.metadata.instanceUrl === 'string' ? account.metadata.instanceUrl : ''
    account = await refreshNativeAccount(admin, job.account_id, workerId, credentialVersion, account, provider, ctx,
      accountCredentialContext(account.platform, account.remoteId, instance))
  } catch (error) {
    if (error instanceof NativeProviderError) return result(error.code === 'TEMPORARY_FAILURE' ? 'retry' : 'failed', error.code, undefined, error.retryAfterSeconds)
    throw error
  }
  try { for (const item of media) await ctx.readMedia(item) }
  catch { return result('failed', 'MEDIA_HASH_MISMATCH') }
  const nonce = randomUUID()
  const begin = await callRpc<BeginResult>(admin, 'social_native_begin_publication', {
    p_job: jobId, p_worker_id: workerId, p_attempt_no: attemptNo, p_nonce: nonce,
    p_key: nativeRecordKey(), p_hash: hash, p_enabled: publishingEnabled(),
  })
  if (!begin.ok) return begin
  if (!begin.send) return settle(begin.publication)
  const deadline = AbortSignal.timeout(240_000)
  const network = ctx.fetch
  ctx.fetch = (url, init = {}) => network(url, { ...init, signal: init.signal ? AbortSignal.any([deadline, init.signal]) : deadline })
  ctx.beforePublish = async () => {
    if (deadline.aborted) throw new NativeProviderError('TEMPORARY_FAILURE', 0, false)
    const gate = await callRpc<Transition>(admin, 'social_native_publication_gate', { p_job: jobId, p_nonce: nonce,
      p_worker_id: workerId, p_attempt_no: attemptNo, p_hash: hash, p_enabled: publishingEnabled() })
    if (!gate.ok) throw new NativeProviderError('TEMPORARY_FAILURE', 0, false)
  }
  ctx.checkpoint = async (publication) => {
    if (!await persistPublication(admin, jobId, nonce, publication)) throw new NativeProviderError('UNKNOWN_RESULT', 0, true)
  }
  const input: NativePublishInput = { jobId, attemptNo, idempotencyKey: begin.publication.idempotency_key,
    account, text: destination.text, settings: destination.settings, media, scheduledAt: destination.scheduled_at }
  let publication: NativePublication | undefined
  let error: NativeProviderError | undefined
  try { publication = await provider.publish(ctx, input) }
  catch (cause) { error = cause instanceof NativeProviderError ? cause : new NativeProviderError('UNKNOWN_RESULT', 0, true) }
  const state = publication?.status === 'published' ? 'published' : publication ? 'processing' : error?.ambiguous ? 'unknown' : 'rejected'
  const saved = await callRpc<boolean>(admin, 'social_native_finish_publication', {
    p_job: jobId, p_nonce: nonce, p_state: state, p_remote_id: publication?.remoteId ?? null,
    p_remote_url: publication?.remoteUrl ?? null, p_metadata: publication ? publicationMetadata(publication, jobId) : {},
    p_error_code: error?.code ?? null, p_retry_after_seconds: error?.retryAfterSeconds ?? null,
  })
  if (!saved) return { ok: false, http: 409, code: 'LEASE_LOST' }
  return settle({ job_id: jobId, state, remote_id: publication?.remoteId ?? null, remote_url: publication?.remoteUrl ?? null,
    metadata: publication?.metadata ?? {}, error_code: error?.code ?? null, retry_after_seconds: error?.retryAfterSeconds ?? null })
}

function publicationMetadata(publication: NativePublication, jobId: string): JsonObject {
  const metadata = { ...publication.metadata }
  delete metadata._private
  if (publication.privateData && publication.status === 'processing') metadata._private = sealCredentials({ secrets: publication.privateData }, `publication:${jobId}`)
  return metadata
}
async function persistPublication(admin: SupabaseClient, jobId: string, nonce: string, publication: NativePublication): Promise<boolean> {
  return callRpc<boolean>(admin, 'social_native_finish_publication', { p_job: jobId, p_nonce: nonce,
    p_state: publication.status, p_remote_id: publication.remoteId, p_remote_url: publication.remoteUrl ?? null,
    p_metadata: publicationMetadata(publication, jobId), p_error_code: null, p_retry_after_seconds: null })
}
