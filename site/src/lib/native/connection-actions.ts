'use server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { ActionRefusal, callRpc, isUuid, runAdminAction, type ActionResult } from '../social/server/run-admin-action.ts'
import { CONNECTION_FORMS, CREDENTIAL_PLATFORMS, type CredentialPlatform } from './connections-catalog.ts'
import { sealCredentials } from './credentials.ts'
import { NativeProviderError } from './http.ts'
import { nativeProvider } from './providers/index.ts'
import { accountCredentialContext, nativeContext } from './server.ts'

const connectionSchema = z.object({
  platform: z.enum(CREDENTIAL_PLATFORMS), brandId: z.uuid(),
  secrets: z.record(z.string(), z.string().max(32768)),
  instanceUrl: z.string().max(2048).optional(), destinationId: z.string().max(512).optional(),
}).strict()

export async function connectNativeAccount(input: {
  platform: CredentialPlatform; brandId: string; secrets: Record<string, string>; instanceUrl?: string; destinationId?: string
}): Promise<ActionResult<{ accountId: string }>> {
  return runAdminAction('nativeConnect', {}, async (actor) => {
    const parsed = connectionSchema.safeParse(input)
    if (!parsed.success) throw new ActionRefusal('Completeaza platforma, brandul si datele de conectare.')
    const form = CONNECTION_FORMS.find((item) => item.platform === parsed.data.platform)!
    const secrets = Object.fromEntries(form.fields.map(field => {
      const value = parsed.data.secrets[field.key] || ''
      return [field.key, field.key === 'password' ? value : value.trim()]
    }))
    if (form.fields.some(field => !field.optional && !secrets[field.key])) throw new ActionRefusal('Completeaza toate datele de conectare.')
    if (form.destination && !parsed.data.destinationId?.trim()) throw new ActionRefusal('Completeaza destinatia de publicare.')
    if (form.instance && form.platform !== 'bluesky' && !parsed.data.instanceUrl?.trim()) throw new ActionRefusal('Completeaza adresa HTTPS a instantei.')
    // Verify encryption configuration before contacting the platform.
    try { sealCredentials({ secrets }, 'native-connection-check') }
    catch { throw new ActionRefusal('Configureaza NATIVE_CREDENTIALS_KEY pe server sau secretul local de autentificare.') }
    const admin = createAdminClient()
    const { data: brand, error } = await admin.from('social_brands').select('id').eq('id', parsed.data.brandId).maybeSingle()
    if (error || !brand) throw new ActionRefusal('Alege un brand din lista.')
    let account
    try {
      const accounts = await nativeProvider(form.platform).connect(nativeContext(admin), {
        credentials: { secrets }, instanceUrl: parsed.data.instanceUrl || undefined, destinationId: parsed.data.destinationId || undefined,
      })
      if (accounts.length !== 1) throw new Error('NATIVE_DESTINATION_SELECTION_REQUIRED')
      account = accounts[0]
    } catch (cause) {
      if (cause instanceof NativeProviderError) {
        if (cause.code === 'AUTH_EXPIRED') throw new ActionRefusal('Platforma a refuzat datele. Verifica parola de aplicatie sau tokenul.')
        if (cause.code === 'PERMISSION_DENIED') throw new ActionRefusal('Contul nu are permisiunea de publicare. Verifica rolul si accesul aplicatiei.')
        if (cause.code === 'RATE_LIMITED') throw new ActionRefusal('Platforma limiteaza cererile. Incearca din nou mai tarziu.')
      }
      throw new ActionRefusal('Conectarea nu a reusit. Verifica datele, destinatia si adresa instantei.')
    }
    const instance = typeof account.metadata.instanceUrl === 'string' ? account.metadata.instanceUrl : ''
    const accountId = await callRpc<string>(admin, 'social_native_connect', {
      p_platform: account.platform, p_remote_id: account.remoteId, p_instance_url: instance,
      p_name: account.displayName.slice(0, 120), p_profile_url: account.profileUrl ?? null, p_picture_url: account.pictureUrl ?? null,
      p_brand: parsed.data.brandId, p_encrypted: sealCredentials(account.credentials, accountCredentialContext(account.platform, account.remoteId, instance)),
      p_metadata: account.metadata, p_expires_at: account.credentials.expiresAt ?? null, p_actor: actor.userId,
    })
    revalidatePath('/admin/social/conturi')
    return { ok: true, accountId }
  })
}

export async function disconnectNativeAccount(accountId: string): Promise<ActionResult> {
  return runAdminAction('nativeDisconnect', { SOCIAL_ACCOUNT_NOT_FOUND: 'Contul nu mai exista.' }, async (actor) => {
    if (!isUuid(accountId)) throw new ActionRefusal('Alege un cont din lista.')
    await callRpc(createAdminClient(), 'social_native_disconnect', { p_account: accountId, p_actor: actor.userId })
    revalidatePath('/admin/social/conturi')
    return { ok: true }
  })
}
