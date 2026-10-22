import { PLATFORMS, type Platform } from '../social/constants.ts'
import { CREDENTIAL_PLATFORMS } from './connections-catalog.ts'

export const OAUTH_CONNECTIONS = [
  { value: 'instagram', label: 'Instagram (Business / Creator)' }, { value: 'facebook', label: 'Facebook Pages' },
  { value: 'x', label: 'X' }, { value: 'linkedin', label: 'LinkedIn (profil)' }, { value: 'linkedin-page', label: 'LinkedIn (pagina)' },
  { value: 'tiktok', label: 'TikTok' }, { value: 'youtube', label: 'YouTube' },
] as const
export const EXCLUDED_NATIVE_PLATFORMS: readonly Platform[] = ['wordpress', 'discord', 'mastodon']
export const AUTOMATIC_API_PLATFORMS: readonly Platform[] = [...CREDENTIAL_PLATFORMS, ...OAUTH_CONNECTIONS.map(item => item.value)]
const IMPLEMENTATION_PENDING: readonly Platform[] = ['threads', 'reddit', 'pinterest', 'nostr', 'vk', 'gmb', 'tumblr', 'dribbble', 'whop', 'moltbook', 'kick', 'twitch']
export function apiAvailability(platform: Platform): { state: 'available' | 'conditional' | 'inactive' | 'excluded'; reason: string } {
  if (EXCLUDED_NATIVE_PLATFORMS.includes(platform)) return { state: 'excluded', reason: 'Exclus din proiect la cerere.' }
  if (platform === 'medium') return { state: 'conditional', reason: 'API vechi, fara suport sau integrari noi. Conectarea automata este disponibila numai cu un token existent care inca functioneaza.' }
  if (platform === 'hashnode') return { state: 'conditional', reason: 'Publicarea prin API necesita plan Pro activ si drept de publicare in publicatie.' }
  if (AUTOMATIC_API_PLATFORMS.includes(platform)) return { state: 'available', reason: 'Conector API disponibil. Conecteaza contul si verifica permisiunile cerute de platforma.' }
  if (platform === 'forum' || platform === 'press') return { state: 'inactive', reason: 'Necesita un site concret si API-ul sau metoda de integrare a acelui site.' }
  if (IMPLEMENTATION_PENDING.includes(platform)) return { state: 'inactive', reason: 'Conectorul API direct nu este implementat in aplicatie. Publicarea automata nu este activa.' }
  return { state: 'inactive', reason: 'Integrarea automata nu este disponibila in aplicatie; trebuie verificata metoda oficiala de publicare si accesul oferit contului.' }
}
export const INACTIVE_API_PLATFORMS = PLATFORMS.filter(platform => apiAvailability(platform).state === 'inactive')
