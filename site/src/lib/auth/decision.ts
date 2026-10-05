/**
 * Who may use /admin (amendment 02): a Supabase Auth user whose email is in
 * ADMIN_EMAILS, with a verified TOTP factor, in a session that has used it
 * (aal2). Pure, so the rule is tested without Supabase.
 *
 * Fails closed: an empty or missing ADMIN_EMAILS lets nobody in. The factor
 * list must be the LIVE one from getUser(), not a token claim, so a factor
 * removed elsewhere is noticed at once.
 */

export type AdminDecision = 'ok' | 'login' | 'forbidden' | 'enroll' | 'verify'

export interface AdminDecisionInput {
  email: string | null | undefined
  allowlist: readonly string[]
  /** At least one TOTP factor with status "verified" on the live user. */
  hasVerifiedTotp: boolean
  /** Current authenticator assurance level of the session. */
  aal: string | null | undefined
}

export function parseAdminEmails(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes('@'))
}

export function isAllowedEmail(email: string | null | undefined, allowlist: readonly string[]): boolean {
  if (!email) return false
  return allowlist.includes(email.trim().toLowerCase())
}

export function adminDecision(input: AdminDecisionInput): AdminDecision {
  if (!input.email) return 'login'
  if (!isAllowedEmail(input.email, input.allowlist)) return 'forbidden'
  if (!input.hasVerifiedTotp) return 'enroll'
  if (input.aal !== 'aal2') return 'verify'
  return 'ok'
}

interface FactorLike {
  factor_type?: string
  status?: string
}

export function hasVerifiedTotp(factors: readonly FactorLike[] | null | undefined): boolean {
  return (factors ?? []).some((f) => f.factor_type === 'totp' && f.status === 'verified')
}

/** Where to send someone after login / MFA: only same-site paths under /admin. */
export function safeNext(next: string | null | undefined, fallback = '/admin/social'): string {
  if (!next || !next.startsWith('/admin') || next.startsWith('//') || next.includes('\\')) return fallback
  return next
}

export const ADMIN_DECISION_MESSAGES: Record<Exclude<AdminDecision, 'ok'>, string> = {
  login: 'Intra in cont ca sa continui.',
  forbidden: 'Contul tau nu are acces la panoul de administrare.',
  enroll: 'Activeaza autentificarea in doi pasi ca sa folosesti panoul.',
  verify: 'Confirma codul din aplicatia de autentificare si incearca din nou.',
}

/** Thrown by requireAdmin() inside server actions; the UI shows its message. */
export class AdminAuthError extends Error {
  readonly decision: Exclude<AdminDecision, 'ok'>
  constructor(decision: Exclude<AdminDecision, 'ok'>) {
    super(ADMIN_DECISION_MESSAGES[decision])
    this.name = 'AdminAuthError'
    this.decision = decision
  }
}
