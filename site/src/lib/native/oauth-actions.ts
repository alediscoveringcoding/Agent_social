'use server'
import { randomUUID } from 'node:crypto'
import { cookies } from 'next/headers'
import { createAdminClient } from '@/lib/supabase/admin'
import { ActionRefusal, callRpc, isUuid, runAdminAction, type ActionResult } from '../social/server/run-admin-action.ts'
import { sealCredentials } from './credentials.ts'
import { authorizationUrl, newOAuthAttempt } from './oauth.ts'
import { oauthConfig, OAUTH_PLATFORMS, type OAuthPlatform } from './oauth-config.ts'

export async function startNativeOAuth(input: { platform: OAuthPlatform; brandId: string }): Promise<ActionResult<{ url: string }>> {
  return runAdminAction('nativeOAuth', {}, async (actor) => {
    if (!OAUTH_PLATFORMS.includes(input?.platform) || !isUuid(input?.brandId)) throw new ActionRefusal('Alege platforma si brandul.')
    const admin = createAdminClient()
    const { data: brand, error } = await admin.from('social_brands').select('id').eq('id', input.brandId).maybeSingle()
    if (error || !brand) throw new ActionRefusal('Alege un brand din lista.')
    let config
    try { config = oauthConfig(input.platform) }
    catch (cause) {
      const name = cause instanceof Error ? /^NATIVE_SETUP_REQUIRED:([A-Z_]+)$/.exec(cause.message)?.[1] : null
      throw new ActionRefusal(name ? `Lipseste ${name} din configurarea serverului. Adauga datele aplicatiei de developer.` : 'Verifica adresa publica si configurarea OAuth a serverului.')
    }
    const attempt = newOAuthAttempt()
    const id = randomUUID()
    let encrypted
    try { encrypted = sealCredentials({ secrets: { verifier: attempt.verifier } }, `oauth:${id}`) }
    catch { throw new ActionRefusal('Configureaza cheia de criptare a conexiunilor pe server.') }
    const url = authorizationUrl(config, attempt.state, attempt.verifier)
    await callRpc(admin, 'social_native_oauth_begin', { p_id: id, p_state_hash: attempt.stateHash, p_browser_hash: attempt.browserHash,
      p_actor: actor.userId, p_platform: input.platform, p_brand: input.brandId, p_encrypted: encrypted, p_redirect_uri: config.redirectUri })
    const jar = await cookies()
    jar.set(`native_oauth_${attempt.stateHash.slice(0, 16)}`, attempt.browserBinding, { httpOnly: true, secure: config.redirectUri.startsWith('https:'),
      sameSite: 'lax', path: '/api/native/callback', maxAge: 600 })
    return { ok: true, url }
  })
}
