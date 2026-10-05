/**
 * Accounts screen rules (PRD F1, flow 6.3), shared by the screen, the server
 * actions and the tests. Pure: the database applies the same rules again in
 * social_admin_update_account (0005), under a row lock.
 */

import { MANUAL_ONLY_PLATFORMS, type AccountStatus, type Platform } from './constants.ts'

export type AccountMode = 'auto' | 'manual'

/** Which statuses fit each mode (0005 refuses the other combinations). */
export const STATUSES_FOR_MODE: Record<AccountMode, readonly AccountStatus[]> = {
  auto: ['connected', 'reconnect_required', 'developer_setup_required', 'approval_pending'],
  manual: ['manual', 'approval_pending'],
}

/** PRD F1: warn when the worker or the account sync is older than this. */
export const WORKER_SEEN_WARN_MINUTES = 5
export const ACCOUNT_SYNC_WARN_MINUTES = 30

export const ACCOUNT_STATUS_TONES: Record<AccountStatus, 'accent' | 'danger' | 'warn' | 'neutral'> = {
  connected: 'accent',
  reconnect_required: 'danger',
  developer_setup_required: 'danger',
  approval_pending: 'warn',
  manual: 'neutral',
}

/** What each status asks of a person, in one line. */
export const ACCOUNT_STATUS_HINTS: Record<AccountStatus, string> = {
  connected: 'Publica automat prin Postiz.',
  reconnect_required: 'Reconecteaza canalul in Postiz; urmatoarea sincronizare il marcheaza conectat.',
  developer_setup_required: 'Lipsesc permisiuni sau aplicatia de developer. Dupa rezolvare, marcheaza-l conectat.',
  approval_pending: 'Platforma nu a aprobat inca accesul. Pana atunci, publica manual.',
  manual: 'Publicare manuala: la ora programata apare in Publicare manuala.',
}

export function isManualOnlyPlatform(platform: Platform): boolean {
  return MANUAL_ONLY_PLATFORMS.includes(platform)
}

export interface AccountState {
  brand_id: string | null
  platform: Platform
  mode: AccountMode
  status: AccountStatus
  paused: boolean
  postiz_integration_id: string | null
  postiz_disabled: boolean
}

/**
 * Why an account will not publish automatically right now, as short reasons
 * for the screen. Empty for an account the worker can publish to.
 */
export function publishBlockers(a: AccountState): string[] {
  const out: string[] = []
  if (!a.brand_id) out.push('fara brand')
  if (a.paused) out.push('pe pauza')
  if (a.mode === 'manual') out.push('manual')
  else {
    if (a.status !== 'connected') out.push('neconectat')
    if (!a.postiz_integration_id) out.push('fara canal Postiz')
    if (a.postiz_disabled) out.push('dezactivat in Postiz')
  }
  return out
}

export type Freshness = 'ok' | 'stale' | 'never'

/** "Worker last seen" / "last account sync" against the PRD F1 thresholds. */
export function freshness(at: string | Date | null | undefined, now: Date, warnMinutes: number): Freshness {
  if (!at) return 'never'
  const t = new Date(at).getTime()
  if (!Number.isFinite(t)) return 'never'
  return now.getTime() - t > warnMinutes * 60_000 ? 'stale' : 'ok'
}

/** "acum 3 min", "acum 2 h", "acum 4 zile". */
export function ago(at: string | Date | null | undefined, now: Date): string {
  if (!at) return 'niciodata'
  const t = new Date(at).getTime()
  if (!Number.isFinite(t)) return 'niciodata'
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000))
  if (s < 60) return 'acum cateva secunde'
  const m = Math.floor(s / 60)
  if (m < 60) return `acum ${m} min`
  const h = Math.floor(m / 60)
  if (h < 48) return `acum ${h} h`
  return `acum ${Math.floor(h / 24)} zile`
}

export interface AccountPatch {
  brand_id?: string | null
  mode?: AccountMode
  status?: AccountStatus
  daily_cap?: number
  paused?: boolean
  open_editor_url?: string | null
  display_name?: string
  profile_url?: string | null
}

export const ACCOUNT_PATCH_KEYS = [
  'brand_id',
  'mode',
  'status',
  'daily_cap',
  'paused',
  'open_editor_url',
  'display_name',
  'profile_url',
] as const satisfies ReadonlyArray<keyof AccountPatch>
