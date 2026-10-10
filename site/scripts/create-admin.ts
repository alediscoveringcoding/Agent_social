/**
 * Create an admin user (amendment 02).
 *
 *   npm run admin:create -- --email you@example.com
 *   npm run admin:create -- --email you@example.com --password '...'
 *   npm run admin:create -- --email you@example.com --reset    (local mode: new password, authenticator removed)
 *
 * Without --password a random one is generated and printed once. The address
 * must also be in ADMIN_EMAILS, and the user enrols TOTP at first login.
 *
 * DB_MODE=local (TEMPORARY, src/lib/local/): the user goes into the local
 * PGlite database; stop `npm run dev` first (one process owns the files).
 *
 * Supabase mode: THIS app's Supabase Auth. Refuses any Supabase URL that is
 * not on this machine unless --allow-remote is given: the MVP database is
 * local, and this script must never create users in somebody else's project
 * by accident.
 *
 * Env (.env.local): DB_MODE, ADMIN_EMAILS; for Supabase also
 * NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */

import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { isAllowedEmail, parseAdminEmails } from '../src/lib/auth/decision.ts'

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    reset: { type: 'boolean', default: false },
    'allow-remote': { type: 'boolean', default: false },
  },
})

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const email = (values.email ?? '').trim().toLowerCase()
if (!email.includes('@')) fail('Usage: npm run admin:create -- --email you@example.com [--password ...]')
if (!isAllowedEmail(email, parseAdminEmails(process.env.ADMIN_EMAILS))) {
  console.warn(`Warning: ${email} is not in ADMIN_EMAILS; add it or the login will be refused.`)
}

const generated = !values.password
const password = values.password ?? randomBytes(18).toString('base64url')
if (password.length < 12) fail('Use a password of at least 12 characters.')

async function createLocal(): Promise<string> {
  const { LocalDbInUseError, openLocalDb } = await import('../src/lib/local/db.ts')
  const { hashPassword } = await import('../src/lib/local/crypto.ts')
  let local
  try {
    local = await openLocalDb()
  } catch (e) {
    if (e instanceof LocalDbInUseError) fail(e.message)
    throw e
  }
  try {
    const hash = await hashPassword(password)
    const existing = (await local.db.query<{ user_id: string }>('select user_id from local.admins where email = $1', [email])).rows[0]
    if (existing) {
      if (!values.reset) fail(`${email} already exists. Use --reset to set a new password and remove the authenticator.`)
      await local.db.query(
        `update local.admins set password_hash = $2, totp_factor_id = null, totp_secret = null,
                totp_verified = false, totp_last_step = null,
                failed_count = 0, locked_until = null, session_epoch = session_epoch + 1 where user_id = $1`,
        [existing.user_id, hash]
      )
      return `Admin reset (local database): ${email}. Enrol the authenticator again at the next login.`
    }
    const { rows } = await local.db.query<{ id: string }>('insert into auth.users (email) values ($1) returning id', [email])
    await local.db.query('insert into local.admins (user_id, email, password_hash) values ($1, $2, $3)', [rows[0].id, email, hash])
    return `Admin user created (local database): ${email} (${rows[0].id})`
  } finally {
    await local.close()
  }
}

async function createInSupabase(): Promise<string> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) fail('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (.env.local), or DB_MODE=local.')
  if (values.reset) fail('--reset is for local mode; in Supabase reset the user in Supabase Studio.')

  const host = new URL(url).hostname
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !values['allow-remote']) {
    fail(`Refusing to create a user on ${host}: not a local Supabase. Pass --allow-remote if this is really intended.`)
  }
  const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) fail(`Could not create the user: ${error.message}`)
  return `Admin user created: ${data.user?.email} (${data.user?.id})`
}

console.log(process.env.DB_MODE === 'local' ? await createLocal() : await createInSupabase())
if (generated) console.log(`Password (shown once, store it in your password manager): ${password}`)
console.log('Next: npm run dev, open http://localhost:3000/login, then enrol an authenticator app.')
