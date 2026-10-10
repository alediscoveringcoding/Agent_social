/**
 * TEMPORARY local mode (see mode.ts): what Supabase Auth does for us otherwise.
 * Passwords (scrypt), TOTP codes (RFC 6238: SHA-1, 30 s steps, 6 digits, what
 * authenticator apps use) and the signed session cookie. node:crypto only, so
 * the proxy, the server and the scripts can all use it.
 */

import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

function scryptKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key)))
  )
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  return `scrypt$${salt.toString('base64url')}$${(await scryptKey(password, salt)).toString('base64url')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const got = await scryptKey(password, Buffer.from(salt, 'base64url'))
  const want = Buffer.from(hash, 'base64url')
  return got.length === want.length && timingSafeEqual(got, want)
}

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of text.toUpperCase().replace(/[\s=]/g, '')) {
    const i = B32.indexOf(ch)
    if (i < 0) throw new Error('invalid base32')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** RFC 4226 HOTP. */
export function hotp(key: Uint8Array, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const h = createHmac('sha1', key).update(msg).digest()
  const off = h[h.length - 1] & 0xf
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}

export const TOTP_PERIOD_S = 30

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_S)
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/**
 * The time step `code` matches (the current one, or one either side for clock
 * drift), or null. Steps up to `lastStep` are refused, so each code works once.
 */
export function verifyTotp(secret: string, code: string, nowMs: number, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const key = base32Decode(secret)
  const now = totpStep(nowMs)
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue
    if (timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(code))) return step
  }
  return null
}

/** For authenticator apps that take a link instead of a typed key. */
export function otpauthUri(secret: string, email: string, issuer = 'Social admin (local)'): string {
  const label = encodeURIComponent(`${issuer}:${email}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_PERIOD_S}`
}

// ---------------------------------------------------------------------------
// Session cookie: base64url(JSON).HMAC-SHA256, httpOnly
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'social_local_session'
export const SESSION_TTL_S = 12 * 3600

export interface LocalSession {
  uid: string
  email: string
  /** aal1 after the password, aal2 after a TOTP code (Supabase's levels). */
  aal: 'aal1' | 'aal2'
  /** Unix seconds. */
  exp: number
  /** local.admins.session_epoch when signed; a cookie from an older epoch (sign-out, new authenticator, reset) is dead. */
  epoch: number
}

/** LOCAL_AUTH_SECRET, or null when it is missing or too short to sign with. */
export function authSecret(): string | null {
  const s = process.env.LOCAL_AUTH_SECRET ?? ''
  return s.length >= 32 ? s : null
}

function mac(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function signSession(session: LocalSession, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url')
  return `${payload}.${mac(payload, secret)}`
}

export function verifySession(token: string | undefined, secret: string | null, nowMs = Date.now()): LocalSession | null {
  if (!token || !secret) return null
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const want = Buffer.from(mac(payload, secret))
  const got = Buffer.from(sig)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as LocalSession
    const valid =
      typeof s.uid === 'string' && typeof s.email === 'string' && (s.aal === 'aal1' || s.aal === 'aal2') && typeof s.exp === 'number' && Number.isSafeInteger(s.epoch)
    return valid && s.exp * 1000 > nowMs ? s : null
  } catch {
    return null
  }
}
