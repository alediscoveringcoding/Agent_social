/**
 * Stands in for `@/lib/auth/admin` under the test loader (test/hooks.mjs).
 * The test decides who is signed in: setTestAdmin(identity) or null.
 */
import { AdminAuthError } from '../auth/decision.ts'

export interface AdminIdentity {
  userId: string
  email: string
}

const KEY = Symbol.for('social.test.admin')
type Holder = { [KEY]?: AdminIdentity | null }

export function setTestAdmin(identity: AdminIdentity | null): void {
  ;(globalThis as Holder)[KEY] = identity
}

export async function requireAdmin(): Promise<AdminIdentity> {
  const identity = (globalThis as Holder)[KEY]
  if (!identity) throw new AdminAuthError('verify')
  return identity
}

export async function requireAdminPage(): Promise<AdminIdentity> {
  return requireAdmin()
}

export async function getAdminState() {
  const identity = (globalThis as Holder)[KEY] ?? null
  return { decision: identity ? 'ok' : 'login', identity }
}
