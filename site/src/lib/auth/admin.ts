import 'server-only'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createSessionClient } from '@/lib/supabase/server'
import { AdminAuthError, adminDecision, hasVerifiedTotp, parseAdminEmails, safeNext, type AdminDecision } from './decision.ts'

export interface AdminIdentity {
  userId: string
  email: string
}

export interface AdminState {
  decision: AdminDecision
  identity: AdminIdentity | null
}

/**
 * The session's standing: one getUser() round trip (live factor list) and a
 * local read of the assurance level from the token.
 */
export async function getAdminState(): Promise<AdminState> {
  const supabase = await createSessionClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { decision: 'login', identity: null }
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  const decision = adminDecision({
    email: user.email,
    allowlist: parseAdminEmails(process.env.ADMIN_EMAILS),
    hasVerifiedTotp: hasVerifiedTotp(user.factors),
    aal: aal?.currentLevel ?? null,
  })
  return { decision, identity: user.email ? { userId: user.id, email: user.email } : null }
}

/**
 * For server actions: a server action is a public endpoint, so every one of
 * them calls this first, whatever page rendered the button.
 */
export async function requireAdmin(): Promise<AdminIdentity> {
  const state = await getAdminState()
  if (state.decision !== 'ok' || !state.identity) {
    throw new AdminAuthError(state.decision === 'ok' ? 'login' : state.decision)
  }
  return state.identity
}

/**
 * For pages and layouts: redirect to login / MFA instead of throwing. Without
 * `next`, the way back is the requested path (x-pathname, set by src/proxy.ts),
 * so a layout keeps a nested route like /admin/social/ciorne/<id>.
 */
export async function requireAdminPage(next?: string): Promise<AdminIdentity> {
  const state = await getAdminState()
  if (state.decision === 'ok' && state.identity) return state.identity
  const back = safeNext(next ?? (await headers()).get('x-pathname'))
  const q = `?next=${encodeURIComponent(back)}`
  if (state.decision === 'login') redirect(`/login${q}`)
  if (state.decision === 'forbidden') redirect('/login?error=forbidden')
  redirect(`/mfa${q}`)
}
