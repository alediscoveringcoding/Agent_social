/**
 * Create an admin user in THIS app's Supabase Auth (amendment 02).
 *
 *   npm run admin:create -- --email you@example.com
 *   npm run admin:create -- --email you@example.com --password '...'
 *
 * Without --password a random one is generated and printed once. The address
 * must also be in ADMIN_EMAILS, and the user enrols TOTP at first login.
 *
 * Refuses any Supabase URL that is not on this machine unless --allow-remote
 * is given: the MVP database is local, and this script must never create users
 * in somebody else's project by accident.
 *
 * Env (.env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_EMAILS.
 */

import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { isAllowedEmail, parseAdminEmails } from '../src/lib/auth/decision.ts'

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    'allow-remote': { type: 'boolean', default: false },
  },
})

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) fail('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (.env.local).')

const host = new URL(url).hostname
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !values['allow-remote']) {
  fail(`Refusing to create a user on ${host}: not a local Supabase. Pass --allow-remote if this is really intended.`)
}

const email = (values.email ?? '').trim().toLowerCase()
if (!email.includes('@')) fail('Usage: npm run admin:create -- --email you@example.com [--password ...]')
if (!isAllowedEmail(email, parseAdminEmails(process.env.ADMIN_EMAILS))) {
  console.warn(`Warning: ${email} is not in ADMIN_EMAILS; add it or the login will be refused.`)
}

const generated = !values.password
const password = values.password ?? randomBytes(18).toString('base64url')
if (password.length < 12) fail('Use a password of at least 12 characters.')

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true })
if (error) fail(`Could not create the user: ${error.message}`)

console.log(`Admin user created: ${data.user?.email} (${data.user?.id})`)
if (generated) console.log(`Password (shown once, store it in your password manager): ${password}`)
console.log('Next: npm run dev, open http://localhost:3000/login, then enrol an authenticator app.')
