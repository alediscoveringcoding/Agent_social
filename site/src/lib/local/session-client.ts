import 'server-only'
import { randomUUID } from 'node:crypto'
import { cookies, headers } from 'next/headers'
import { getLocalDb } from './db.ts'
import {
  SESSION_COOKIE,
  SESSION_TTL_S,
  authSecret,
  hashPassword,
  newTotpSecret,
  otpauthUri,
  signSession,
  verifyPassword,
  verifySession,
  verifyTotp,
  type LocalSession,
} from './crypto.ts'

/**
 * TEMPORARY local mode (see mode.ts): the part of Supabase Auth the app uses
 * (src/lib/auth/admin.ts and actions.ts), answered from local.admins and a
 * signed httpOnly cookie, with the same shapes, so the auth code above it is
 * unchanged: password sign-in gives aal1, a TOTP code raises it to aal2, and
 * the factor list is read live from the database on every check.
 */

interface AdminRow {
  user_id: string
  email: string
  password_hash: string
  totp_factor_id: string | null
  totp_secret: string | null
  totp_verified: boolean
  totp_last_step: number | null
  failed_count: number
  session_epoch: number
  /** Computed in SQL (select below): the lock has not run out yet. */
  locked: boolean
}

const authError = (message: string) => ({ name: 'AuthApiError', message, status: 400 })
const nowS = () => Math.floor(Date.now() / 1000)

/** Consecutive wrong passwords or codes before an admin is locked, and for how long. */
export const MAX_FAILURES = 10
export const LOCK_MINUTES = 15

let dummyHash: Promise<string> | null = null
/** A fixed hash, computed once, so an unknown email costs one scrypt like a known one. */
const timingHash = () => (dummyHash ??= hashPassword('dummy-password-for-timing-only'))

function toUser(a: AdminRow) {
  return {
    id: a.user_id,
    email: a.email,
    factors: a.totp_factor_id
      ? [{ id: a.totp_factor_id, factor_type: 'totp', status: a.totp_verified ? 'verified' : 'unverified', friendly_name: 'Local TOTP' }]
      : [],
  }
}

export async function createLocalSessionClient() {
  const secret = authSecret()
  if (!secret) throw new Error('DB_MODE=local needs LOCAL_AUTH_SECRET (32+ characters) in .env.local; scripts/update.sh creates it')
  const store = await cookies()
  const db = await getLocalDb()
  // Secure in production or behind https; plain http://127.0.0.1 under `next dev` still works.
  let secure = process.env.NODE_ENV === 'production'
  try {
    if (!secure) secure = (await headers()).get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https'
  } catch {
    // no request context
  }

  const session = () => verifySession(store.get(SESSION_COOKIE)?.value, secret)
  const save = (s: LocalSession | null) => {
    try {
      if (s) store.set(SESSION_COOKIE, signSession(s, secret), { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_S, secure })
      else store.delete(SESSION_COOKIE)
    } catch {
      // A Server Component can only read cookies; the session changes only in actions.
    }
  }
  const admin = async (column: 'user_id' | 'email', value: string) =>
    (
      await db.query<AdminRow>(
        `select *, (locked_until is not null and locked_until > now()) as locked from local.admins where ${column} = $1`,
        [value]
      )
    ).rows[0] ?? null
  const current = async () => {
    const s = session()
    const a = s ? await admin('user_id', s.uid) : null
    // A cookie from an older epoch (signed out, new authenticator, reset) is dead.
    return s && a && s.epoch === a.session_epoch ? { s, a } : null
  }
  /** One more wrong password or code; the MAX_FAILURES-th locks the admin and starts the count over. */
  const fail = (userId: string) =>
    db.query(
      `update local.admins set
         failed_count = case when failed_count + 1 >= $2 then 0 else failed_count + 1 end,
         locked_until = case when failed_count + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end
       where user_id = $1`,
      [userId, MAX_FAILURES, LOCK_MINUTES]
    )

  return {
    auth: {
      async getUser() {
        const c = await current()
        return { data: { user: c ? toUser(c.a) : null }, error: null }
      },

      async signInWithPassword({ email, password }: { email: string; password: string }) {
        const a = await admin('email', email.trim().toLowerCase())
        // Always one scrypt, known email or not (and locked or not): same cost, same message.
        const ok = await verifyPassword(password, a ? a.password_hash : await timingHash())
        if (!a || a.locked || !ok) {
          if (a && !a.locked) await fail(a.user_id)
          return { data: { user: null, session: null }, error: authError('Invalid login credentials') }
        }
        save({ uid: a.user_id, email: a.email, aal: 'aal1', exp: nowS() + SESSION_TTL_S, epoch: a.session_epoch })
        return { data: { user: toUser(a), session: null }, error: null }
      },

      /** Ends every session of this admin (the epoch moves on), not just this browser's. */
      async signOut(_options?: { scope?: string }) {
        const c = await current()
        if (c) await db.query('update local.admins set session_epoch = session_epoch + 1 where user_id = $1', [c.a.user_id])
        save(null)
        return { error: null }
      },

      mfa: {
        async getAuthenticatorAssuranceLevel() {
          const s = (await current())?.s
          return { data: { currentLevel: s?.aal ?? null, nextLevel: s ? 'aal2' : null, currentAuthenticationMethods: [] }, error: null }
        },

        async listFactors() {
          const c = await current()
          const all = c ? toUser(c.a).factors : []
          return { data: { all, totp: all.filter((f) => f.status === 'verified'), phone: [] }, error: null }
        },

        /** Only an unverified factor (an abandoned enrolment) can be removed here, as in the app's flow. */
        async unenroll({ factorId }: { factorId: string }) {
          const c = await current()
          if (c && c.a.totp_factor_id === factorId && !c.a.totp_verified) {
            await db.query('update local.admins set totp_factor_id = null, totp_secret = null where user_id = $1', [c.a.user_id])
          }
          return { data: { id: factorId }, error: null }
        },

        async enroll(_options: { factorType: 'totp'; friendlyName?: string }) {
          const c = await current()
          if (!c) return { data: null, error: authError('Not signed in') }
          if (c.a.totp_verified) return { data: null, error: authError('An authenticator is already active for this account') }
          const totpSecret = newTotpSecret()
          const id = randomUUID()
          const bumped = await db.query<{ session_epoch: number }>(
            `update local.admins set totp_factor_id = $2, totp_secret = $3, totp_last_step = null, session_epoch = session_epoch + 1
             where user_id = $1 returning session_epoch`,
            [c.a.user_id, id, totpSecret]
          )
          save({ ...c.s, epoch: bumped.rows[0].session_epoch })
          // No QR image in local mode (no extra dependency): the page shows the key to type in.
          return { data: { id, type: 'totp', totp: { qr_code: '', secret: totpSecret, uri: otpauthUri(totpSecret, c.a.email) } }, error: null }
        },

        async challengeAndVerify({ factorId, code }: { factorId: string; code: string }) {
          const c = await current()
          if (!c || c.a.totp_factor_id !== factorId || !c.a.totp_secret) return { data: null, error: authError('Unknown factor') }
          const bad = async () => {
            await fail(c.a.user_id)
            return { data: null, error: authError('Invalid TOTP code') }
          }
          if (c.a.locked) return { data: null, error: authError('Invalid TOTP code') }
          const step = verifyTotp(c.a.totp_secret, code, Date.now(), c.a.totp_last_step)
          if (step === null) return bad()
          // Atomic: of two requests with the same code only one gets a row back, and the step never goes down.
          const taken = await db.query<{ session_epoch: number }>(
            `update local.admins set totp_verified = true, totp_last_step = $2, failed_count = 0, locked_until = null,
                    session_epoch = session_epoch + 1
             where user_id = $1 and (totp_last_step is null or totp_last_step < $2) returning session_epoch`,
            [c.a.user_id, step]
          )
          if (!taken.rows[0]) return bad()
          save({ ...c.s, aal: 'aal2', exp: nowS() + SESSION_TTL_S, epoch: taken.rows[0].session_epoch })
          return { data: {}, error: null }
        },
      },
    },
  }
}
