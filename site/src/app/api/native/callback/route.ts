import { cookies } from 'next/headers'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/admin'
import { callRpc } from '@/lib/social/server/run-admin-action'
import { openCredentials } from '@/lib/native/credentials'
import { exchangeOAuthCode, stateHash } from '@/lib/native/oauth'
import { oauthConfig, OAUTH_PLATFORMS, type OAuthPlatform } from '@/lib/native/oauth-config'
import { nativeProvider } from '@/lib/native/providers'
import { nativeContext } from '@/lib/native/server'
import { storeNativeCandidates } from '@/lib/native/candidates'

export const runtime = 'nodejs'
export async function GET(request: Request) {
  // A callback cannot create connections using a stale or unverified login.
  let actor
  try { actor = await requireAdmin() }
  catch { return new Response('Autentifica-te ca administrator si verifica TOTP, apoi reia conectarea.', { status: 403, headers: { 'Cache-Control': 'no-store' } }) }
  const origin = new URL(request.url).origin
  const back = new URL('/admin/social/conturi', origin)
  try {
    const query = new URL(request.url).searchParams
    const hash = stateHash(query.get('state') || '')
    const name = `native_oauth_${hash.slice(0, 16)}`
    const jar = await cookies()
    const binding = jar.get(name)?.value || ''
    const browserHash = stateHash(binding)
    const admin = createAdminClient()
    const attempt = await callRpc<{ id: string; platform: OAuthPlatform; brand_id: string; encrypted: string; redirect_uri: string }>(admin, 'social_native_oauth_consume', {
      p_state_hash: hash, p_browser_hash: browserHash, p_actor: actor.userId,
    })
    jar.set(name, '', { maxAge: 0, path: '/api/native/callback', httpOnly: true, sameSite: 'lax', secure: request.url.startsWith('https:') })
    if (query.has('error')) throw new Error('NATIVE_OAUTH_DENIED')
    if (!OAUTH_PLATFORMS.includes(attempt.platform)) throw new Error('NATIVE_PLATFORM_INVALID')
    const config = oauthConfig(attempt.platform)
    if (config.redirectUri !== attempt.redirect_uri || new URL(config.redirectUri).origin !== origin) throw new Error('NATIVE_CALLBACK_CHANGED')
    const { secrets } = openCredentials(attempt.encrypted, `oauth:${attempt.id}`)
    const ctx = nativeContext(admin)
    const credentials = await exchangeOAuthCode(ctx, config, query.get('code') || '', secrets.verifier)
    const accounts = await nativeProvider(attempt.platform).connect(ctx, { credentials })
    const id = await storeNativeCandidates(admin, actor.userId, attempt.brand_id, accounts)
    return Response.redirect(new URL(`/admin/social/conturi/conectare/${id}`, origin), 303)
  } catch {
    // Authorization codes, raw provider failures and tokens never enter the
    // browser URL, page copy or application logs.
    back.searchParams.set('connection_error', 'failed')
    return Response.redirect(back, 303)
  }
}
