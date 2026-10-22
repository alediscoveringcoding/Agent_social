import { DROPPED_PLATFORMS, DROPPED_PLATFORM_NOTE, EXCLUDED_PLATFORM_NOTE, PLATFORMS, type Platform } from '../social/constants.ts'
import { CREDENTIAL_PLATFORMS } from './connections-catalog.ts'

export const OAUTH_CONNECTIONS = [
  { value: 'instagram', label: 'Instagram (Business / Creator)' }, { value: 'facebook', label: 'Facebook Pages' },
  { value: 'x', label: 'X' }, { value: 'linkedin', label: 'LinkedIn (profil)' }, { value: 'linkedin-page', label: 'LinkedIn (pagina)' },
  { value: 'tiktok', label: 'TikTok' }, { value: 'youtube', label: 'YouTube' },
] as const
/** Excluded by the owner (amendment 08); part of DROPPED_PLATFORMS since amendment 10. */
export const EXCLUDED_NATIVE_PLATFORMS: readonly Platform[] = ['wordpress', 'discord', 'mastodon']
export const AUTOMATIC_API_PLATFORMS: readonly Platform[] = [...CREDENTIAL_PLATFORMS, ...OAUTH_CONNECTIONS.map(item => item.value)]
/** Amendment 10: never implemented after Postiz was removed, and dropped from the app. */
export const NOT_IMPLEMENTED_PLATFORMS: readonly Platform[] = DROPPED_PLATFORMS.filter(platform => !EXCLUDED_NATIVE_PLATFORMS.includes(platform))

export type ApiState = 'available' | 'conditional' | 'inactive' | 'dropped' | 'excluded'
export function apiAvailability(platform: Platform): { state: ApiState; reason: string } {
  if (EXCLUDED_NATIVE_PLATFORMS.includes(platform)) return { state: 'excluded', reason: EXCLUDED_PLATFORM_NOTE }
  if (NOT_IMPLEMENTED_PLATFORMS.includes(platform)) return { state: 'dropped', reason: DROPPED_PLATFORM_NOTE }
  if (platform === 'medium') return { state: 'conditional', reason: 'API vechi, fara suport sau integrari noi. Conectarea automata este disponibila numai cu un token existent care inca functioneaza.' }
  if (platform === 'hashnode') return { state: 'conditional', reason: 'Publicarea prin API necesita plan Pro activ si drept de publicare in publicatie.' }
  if (AUTOMATIC_API_PLATFORMS.includes(platform)) return { state: 'available', reason: 'Conector API disponibil. Conecteaza contul si verifica permisiunile cerute de platforma.' }
  if (platform === 'forum' || platform === 'press') return { state: 'inactive', reason: 'Necesita un site concret si API-ul sau metoda de integrare a acelui site.' }
  return { state: 'inactive', reason: 'Integrarea automata nu este disponibila in aplicatie; trebuie verificata metoda oficiala de publicare si accesul oferit contului. Publicarea manuala ramane posibila.' }
}
/** Kept platforms without automatic publishing: a manual account still works for them. */
export const INACTIVE_API_PLATFORMS = PLATFORMS.filter(platform => apiAvailability(platform).state === 'inactive')
