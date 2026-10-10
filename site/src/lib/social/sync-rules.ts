/**
 * Account sync rules (PRD F1, F7, flow 6.3). Pure.
 *
 * Postiz is the authority on whether a channel needs a refresh, and on
 * nothing else: a status the site set for its own reasons (permissions
 * missing after PERMISSION_DENIED, platform approval pending, manual) is
 * kept until a person changes it, because "Postiz no longer asks for a
 * refresh" does not mean "the missing scope was granted".
 */

import { PROVIDER_TO_PLATFORM, type AccountStatus, type Platform } from './constants.ts'

export function platformForProvider(provider: string): Platform | null {
  return PROVIDER_TO_PLATFORM[provider.trim().toLowerCase()] ?? null
}

/**
 * `refreshNeeded` is tri-state: true (Postiz asks for a reconnect), false (Postiz says the
 * channel is fine) or undefined (Postiz said nothing; v2.25.0's public list has no such field).
 * Silence is not good news: an account in reconnect_required (set by an AUTH_EXPIRED result
 * or an earlier sync) only goes back to connected on an explicit false.
 */
export function syncedStatus(current: AccountStatus | null, refreshNeeded: boolean | undefined): AccountStatus {
  if (refreshNeeded === true) return current === 'manual' ? 'manual' : 'reconnect_required'
  if (current === null) return 'connected'
  if (current === 'reconnect_required') return refreshNeeded === false ? 'connected' : current
  return current
}

/** Did this sync move the account INTO reconnect_required (notify once, not every 15 minutes)? */
export function becameReconnectRequired(before: AccountStatus | null, after: AccountStatus): boolean {
  return after === 'reconnect_required' && before !== 'reconnect_required'
}
