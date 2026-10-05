import { createHmac, timingSafeEqual } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const UPLOAD_TTL = 600
export interface UploadTicket { path: string; mime: string; exp: number; userId: string }

function mac(label: string, value: string): string {
  const key = process.env.MEDIA_SIGNING_SECRET || process.env.LOCAL_AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key || key.length < 32) throw new Error('Media signing requires a secret of at least 32 characters')
  return createHmac('sha256', key).update(`${label}\n${value}`).digest('hex')
}
function equal(a: string, b: string): boolean {
  return /^[0-9a-f]{64}$/.test(a) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}
function validExpiry(exp: number, ttl: number, now: number): boolean {
  return Number.isSafeInteger(exp) && exp > now && exp <= now + ttl + 60
}
export function signedMediaUrl(id: string, ttl = 3600, now = Math.floor(Date.now() / 1000)): string {
  if (!UUID.test(id) || !Number.isInteger(ttl) || ttl < 1 || ttl > 3600) throw new Error('Invalid media URL arguments')
  const exp = now + ttl
  return `/api/media/${id}?exp=${exp}&sig=${mac('media-download-v1', `${id}\n${exp}`)}`
}
export function verifyMediaSignature(id: string, exp: number, sig: string, now = Math.floor(Date.now() / 1000)): boolean {
  return UUID.test(id) && validExpiry(exp, 3600, now) && equal(sig, mac('media-download-v1', `${id}\n${exp}`))
}
export function signUploadTicket(ticket: UploadTicket): string {
  return `${Buffer.from(JSON.stringify(ticket)).toString('base64url')}.${mac('media-upload-v1', JSON.stringify(ticket))}`
}
export function verifyUploadTicket(token: string, now = Math.floor(Date.now() / 1000)): UploadTicket | null {
  if (typeof token !== 'string' || token.length > 2048) return null
  try {
    const [payload, sig, extra] = token.split('.')
    if (!payload || !sig || extra) return null
    const value = Buffer.from(payload, 'base64url').toString('utf8')
    if (!equal(sig, mac('media-upload-v1', value))) return null
    const t = JSON.parse(value) as UploadTicket
    if (!UUID.test(t.userId) || !/^staging\/[0-9a-f-]{36}$/.test(t.path) || !UUID.test(t.path.slice(8))) return null
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(t.mime) || !validExpiry(t.exp, UPLOAD_TTL, now)) return null
    return t
  } catch { return null }
}
