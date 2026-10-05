'use server'

import { redirect } from 'next/navigation'
import { createSessionClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isAllowedEmail, parseAdminEmails, safeNext } from './decision.ts'

/**
 * Sign-in and TOTP for the admin (amendment 02). The session lives in
 * Supabase Auth cookies; these actions only move it forward. The real gate
 * is requireAdmin()/requireAdminPage() on every page and action.
 */

export interface AuthResult {
  error?: string
}

export interface EnrollResult extends AuthResult {
  factorId?: string
  qrCode?: string
  secret?: string
}

async function logAuth(email: string | null, action: string, status: 'success' | 'error', details: Record<string, unknown> = {}) {
  // Logging must never block a sign-in, but a failed write is reported. The
  // client returns {error} instead of throwing, so the catch alone saw nothing.
  try {
    const { error } = await createAdminClient().from('social_activity_log').insert({ actor_email: email, action, status, details })
    if (error) console.error('[auth/activity] could not log %s: %s', action, error.message)
  } catch (e) {
    console.error('[auth/activity] could not log %s:', action, e)
  }
}

export async function signIn(_prev: AuthResult | undefined, form: FormData): Promise<AuthResult> {
  const email = String(form.get('email') ?? '').trim().toLowerCase()
  const password = String(form.get('password') ?? '')
  const next = safeNext(String(form.get('next') ?? ''))
  if (!email || !password) return { error: 'Completeaza emailul si parola.' }

  const supabase = await createSessionClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  // One message for "wrong password" and "not an admin": no account enumeration.
  if (error || !isAllowedEmail(email, parseAdminEmails(process.env.ADMIN_EMAILS))) {
    if (!error) await supabase.auth.signOut({ scope: 'local' })
    await logAuth(email, 'auth.sign_in', 'error', { reason: error ? 'credentials' : 'not_allowlisted' })
    return { error: 'Email sau parola gresite, sau contul nu are acces.' }
  }
  await logAuth(email, 'auth.sign_in', 'success')
  redirect(`/mfa?next=${encodeURIComponent(next)}`)
}

export async function signOut(): Promise<void> {
  const supabase = await createSessionClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  await supabase.auth.signOut({ scope: 'local' })
  await logAuth(user?.email ?? null, 'auth.sign_out', 'success')
  redirect('/login')
}

/** Start TOTP enrolment: a fresh factor with its QR code (old unverified ones are removed first). */
export async function startTotpEnroll(): Promise<EnrollResult> {
  const supabase = await createSessionClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.email || !isAllowedEmail(user.email, parseAdminEmails(process.env.ADMIN_EMAILS))) {
    return { error: 'Intra in cont mai intai.' }
  }
  const { data: factors } = await supabase.auth.mfa.listFactors()
  for (const f of factors?.all ?? []) {
    if (f.factor_type === 'totp' && f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id })
  }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Social admin ${Date.now()}` })
  if (error || !data) return { error: 'Nu am putut porni activarea. Incearca din nou.' }
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret }
}

/** Verify a TOTP code (enrolment or a new session). Success raises the session to aal2. */
export async function verifyTotp(_prev: AuthResult | undefined, form: FormData): Promise<AuthResult> {
  const code = String(form.get('code') ?? '').replace(/\s+/g, '')
  const next = safeNext(String(form.get('next') ?? ''))
  let factorId = String(form.get('factorId') ?? '')
  if (!/^\d{6}$/.test(code)) return { error: 'Codul are 6 cifre.' }

  const supabase = await createSessionClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user?.email || !isAllowedEmail(user.email, parseAdminEmails(process.env.ADMIN_EMAILS))) {
    return { error: 'Intra in cont mai intai.' }
  }
  if (!factorId) {
    factorId = (user.factors ?? []).find((f) => f.factor_type === 'totp' && f.status === 'verified')?.id ?? ''
  }
  if (!factorId) return { error: 'Nu exista un autentificator activ. Activeaza unul.' }

  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code })
  if (error) {
    await logAuth(user.email, 'auth.mfa_verify', 'error')
    return { error: 'Cod gresit sau expirat. Incearca din nou.' }
  }
  await logAuth(user.email, 'auth.mfa_verify', 'success')
  redirect(next)
}
