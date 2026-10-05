import 'server-only'
import { randomUUID } from 'node:crypto'
import { cookies } from 'next/headers'
import { getLocalDb } from './db.ts'
import {
  SESSION_COOKIE,
  SESSION_TTL_S,
  authSecret,
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
}

const authError = (message: string) => ({ name: 'AuthApiError', message, status: 400 })
const nowS = () => Math.floor(Date.now() / 1000)

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

  const session = () => verifySession(store.get(SESSION_COOKIE)?.value, secret)
  const save = (s: LocalSession | null) => {
    try {
      if (s) store.set(SESSION_COOKIE, signSession(s, secret), { httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_S })
      else store.delete(SESSION_COOKIE)
    } catch {
      // A Server Component can only read cookies; the session changes only in actions.
    }
  }
  const admin = async (column: 'user_id' | 'email', value: string) =>
    (await db.query<AdminRow>(`select * from local.admins where ${column} = $1`, [value])).rows[0] ?? null
  const current = async () => {
    const s = session()
    const a = s ? await admin('user_id', s.uid) : null
    return s && a ? { s, a } : null
  }

  return {
    auth: {
      async getUser() {
        const c = await current()
        return { data: { user: c ? toUser(c.a) : null }, error: null }
      },

      async signInWithPassword({ email, password }: { email: string; password: string }) {
        const a = await admin('email', email.trim().toLowerCase())
        if (!a || !(await verifyPassword(password, a.password_hash))) {
          return { data: { user: null, session: null }, error: authError('Invalid login credentials') }
        }
        save({ uid: a.user_id, email: a.email, aal: 'aal1', exp: nowS() + SESSION_TTL_S })
        return { data: { user: toUser(a), session: null }, error: null }
      },

      async signOut(_options?: { scope?: string }) {
        save(null)
        return { error: null }
      },

      mfa: {
        async getAuthenticatorAssuranceLevel() {
          const s = session()
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
          await db.query('update local.admins set totp_factor_id = $2, totp_secret = $3, totp_last_step = null where user_id = $1', [
            c.a.user_id,
            id,
            totpSecret,
          ])
          // No QR image in local mode (no extra dependency): the page shows the key to type in.
          return { data: { id, type: 'totp', totp: { qr_code: '', secret: totpSecret, uri: otpauthUri(totpSecret, c.a.email) } }, error: null }
        },

        async challengeAndVerify({ factorId, code }: { factorId: string; code: string }) {
          const c = await current()
          if (!c || c.a.totp_factor_id !== factorId || !c.a.totp_secret) return { data: null, error: authError('Unknown factor') }
          const step = verifyTotp(c.a.totp_secret, code, Date.now(), c.a.totp_last_step)
          if (step === null) return { data: null, error: authError('Invalid TOTP code') }
          await db.query('update local.admins set totp_verified = true, totp_last_step = $2 where user_id = $1', [c.a.user_id, step])
          save({ ...c.s, aal: 'aal2', exp: nowS() + SESSION_TTL_S })
          return { data: {}, error: null }
        },
      },
    },
  }
}
