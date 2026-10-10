import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const serverDir = mkdtempSync(join(tmpdir(), 'social-local-auth-'))
process.env.LOCAL_DB_DIR = serverDir
process.env.LOCAL_AUTH_SECRET = 'local-auth-secret-for-tests-0123456789'

const { getLocalDb, openLocalDb } = await import('../db.ts')
const { SESSION_COOKIE, authSecret, base32Decode, hashPassword, hotp, signSession, totpStep, verifySession } = await import('../crypto.ts')
const { createLocalSessionClient, MAX_FAILURES, requestIsHttps } = await import('../session-client.ts')

const scratch: string[] = [serverDir]
after(async () => {
  await (await getLocalDb()).close()
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

const jar = () => (globalThis as Record<symbol, Map<string, string>>)[Symbol.for('social.test.cookies')] ?? new Map<string, string>()
const PASSWORD = 'a-long-local-password'
let counter = 0

async function newAdmin() {
  const db = await getLocalDb()
  const email = `hardening-${++counter}@example.test`
  const { rows } = await db.query<{ id: string }>('insert into auth.users (email) values ($1) returning id', [email])
  await db.query('insert into local.admins (user_id, email, password_hash) values ($1, $2, $3)', [rows[0].id, email, await hashPassword(PASSWORD)])
  jar().clear()
  return { db, email, id: rows[0].id }
}
const client = async () => (await createLocalSessionClient()).auth
const row = async (id: string) =>
  (await (await getLocalDb()).query<{ failed_count: number; locked_until: Date | null; session_epoch: number; totp_last_step: number | null }>(
    'select failed_count, locked_until, session_epoch, totp_last_step from local.admins where user_id = $1',
    [id]
  )).rows[0]

/** Password sign-in, enrolment and a first code: a full aal2 session. */
async function fullSignIn(email: string) {
  assert.equal(((await (await client()).signInWithPassword({ email, password: PASSWORD })).error), null)
  const auth = await client()
  const enrolled = await auth.mfa.enroll({ factorType: 'totp' })
  const { id: factorId, totp } = enrolled.data!
  const key = base32Decode(totp.secret)
  assert.equal((await (await client()).mfa.challengeAndVerify({ factorId, code: hotp(key, totpStep(Date.now())) })).error, null)
  return { factorId, key }
}

describe('local login lockout', () => {
  it('locks after 10 consecutive wrong passwords with the generic error, and lets the admin back in afterwards', async () => {
    const { db, email, id } = await newAdmin()
    const generic = (await (await client()).signInWithPassword({ email: 'nobody@example.test', password: 'x'.repeat(14) })).error!.message
    for (let i = 0; i < MAX_FAILURES - 1; i++) assert.equal((await (await client()).signInWithPassword({ email, password: 'wrong-password-1' })).error!.message, generic)
    assert.equal((await row(id)).failed_count, MAX_FAILURES - 1)
    assert.equal((await row(id)).locked_until, null)
    // The 10th failure locks.
    assert.equal((await (await client()).signInWithPassword({ email, password: 'wrong-password-1' })).error!.message, generic)
    const locked = await row(id)
    assert.ok(locked.locked_until && locked.locked_until.getTime() > Date.now() + 14 * 60_000)
    // The right password is refused with the same message while locked.
    assert.equal((await (await client()).signInWithPassword({ email, password: PASSWORD })).error!.message, generic)
    assert.equal((await (await client()).getUser()).data.user, null)
    // Once the lock has run out the right password works.
    await db.query(`update local.admins set locked_until = now() - interval '1 second' where user_id = $1`, [id])
    assert.equal((await (await client()).signInWithPassword({ email, password: PASSWORD })).error, null)
    assert.equal((await row(id)).failed_count, 0, 'the count started over when the lock was set')
  })

  it('locks after 10 wrong authenticator codes and a full sign-in resets the count', async () => {
    const { db, email, id } = await newAdmin()
    await db.query('update local.admins set failed_count = 4 where user_id = $1', [id])
    assert.equal((await (await client()).signInWithPassword({ email, password: PASSWORD })).error, null)
    const enrolled = (await (await client()).mfa.enroll({ factorType: 'totp' })).data!
    const key = base32Decode(enrolled.totp.secret)
    const good = hotp(key, totpStep(Date.now()))
    const bad = String((Number(good) + 500_000) % 1_000_000).padStart(6, '0')
    for (let i = 0; i < MAX_FAILURES - 4; i++) assert.equal((await (await client()).mfa.challengeAndVerify({ factorId: enrolled.id, code: bad })).error!.message, 'Invalid TOTP code')
    assert.ok((await row(id)).locked_until)
    // Locked: even the right code gets the same error.
    assert.equal((await (await client()).mfa.challengeAndVerify({ factorId: enrolled.id, code: good })).error!.message, 'Invalid TOTP code')
    await db.query(`update local.admins set locked_until = null, failed_count = 3 where user_id = $1`, [id])
    assert.equal((await (await client()).mfa.challengeAndVerify({ factorId: enrolled.id, code: good })).error, null)
    const after = await row(id)
    assert.equal(after.failed_count, 0)
    assert.equal(after.locked_until, null)
  })

  it('treats an unknown email like a wrong password', async () => {
    const r = await (await client()).signInWithPassword({ email: 'ghost@example.test', password: PASSWORD })
    assert.equal(r.error!.message, 'Invalid login credentials')
  })
})

describe('local TOTP replay', () => {
  it('refuses a used code, and of two concurrent requests with one code exactly one succeeds', async () => {
    const { email, id } = await newAdmin()
    assert.equal((await (await client()).signInWithPassword({ email, password: PASSWORD })).error, null)
    const enrolled = (await (await client()).mfa.enroll({ factorType: 'totp' })).data!
    const code = hotp(base32Decode(enrolled.totp.secret), totpStep(Date.now()))
    const a = await client()
    const b = await client()
    const results = await Promise.all([a.mfa.challengeAndVerify({ factorId: enrolled.id, code }), b.mfa.challengeAndVerify({ factorId: enrolled.id, code })])
    assert.equal(results.filter((r) => r.error === null).length, 1)
    const step = (await row(id)).totp_last_step
    assert.ok(step !== null)
    // The loser raced a valid code, it did not guess a wrong one: nothing is counted against the admin.
    assert.equal((await row(id)).failed_count, 0, 'a lost race is not a failed attempt')
    // Replaying afterwards (a new request) is refused too, and the step has not gone down.
    assert.ok((await (await client()).mfa.challengeAndVerify({ factorId: enrolled.id, code })).error)
    assert.equal((await row(id)).totp_last_step, step)
    // That one is a stale code, not a race, and it does count.
    assert.equal((await row(id)).failed_count, 1)
  })

  it('does not count the loser of a same-code race, however often it happens, but still locks on real wrong codes', async () => {
    const { email, id } = await newAdmin()
    assert.equal((await (await client()).signInWithPassword({ email, password: PASSWORD })).error, null)
    const enrolled = (await (await client()).mfa.enroll({ factorType: 'totp' })).data!
    const key = base32Decode(enrolled.totp.secret)
    const now = totpStep(Date.now())
    const generic = 'Invalid TOTP code'

    // Two races in a row, each on a later step (the step only moves forward).
    for (const step of [now, now + 1]) {
      const code = hotp(key, step)
      const [a, b] = [await client(), await client()]
      const results = await Promise.all([a.mfa.challengeAndVerify({ factorId: enrolled.id, code }), b.mfa.challengeAndVerify({ factorId: enrolled.id, code })])
      assert.equal(results.filter((r) => r.error === null).length, 1, `step ${step}: one winner`)
      assert.equal(results.find((r) => r.error)!.error!.message, generic, 'the loser gets the generic error')
      assert.equal((await row(id)).failed_count, 0, `step ${step}: the loser was not counted`)
      assert.equal((await row(id)).locked_until, null)
      assert.equal((await row(id)).totp_last_step, step)
    }
  })

  it('counts a different stale code that loses the race: only the same step is free', async () => {
    const { email, id } = await newAdmin()
    assert.equal((await (await client()).signInWithPassword({ email, password: PASSWORD })).error, null)
    const enrolled = (await (await client()).mfa.enroll({ factorType: 'totp' })).data!
    const key = base32Decode(enrolled.totp.secret)
    const now = totpStep(Date.now())
    // Both codes are valid when they are read; the later step is stored first, so the earlier one is stale.
    const [late, early] = [hotp(key, now + 1), hotp(key, now)]
    const [a, b] = [await client(), await client()]
    const results = await Promise.all([a.mfa.challengeAndVerify({ factorId: enrolled.id, code: late }), b.mfa.challengeAndVerify({ factorId: enrolled.id, code: early })])
    assert.equal(results[0].error, null)
    assert.equal(results[1].error!.message, 'Invalid TOTP code')
    const after = await row(id)
    assert.equal(after.totp_last_step, now + 1, 'the step never goes down')
    assert.equal(after.failed_count, 1, 'a different, stale code is a failure')
  })
})

describe('session cookie scheme', () => {
  const headers = (init: Record<string, string>) => new Headers(init)

  it('is https only when the request says so: x-forwarded-proto first', () => {
    assert.equal(requestIsHttps(headers({})), false, 'nothing says https')
    assert.equal(requestIsHttps(headers({ 'x-forwarded-proto': 'https' })), true)
    assert.equal(requestIsHttps(headers({ 'x-forwarded-proto': 'HTTPS' })), true)
    assert.equal(requestIsHttps(headers({ 'x-forwarded-proto': 'http' })), false)
    assert.equal(requestIsHttps(headers({ 'x-forwarded-proto': 'https, http' })), true, 'the first hop is the browser')
    assert.equal(requestIsHttps(headers({ 'x-forwarded-proto': 'http, https' })), false)
    // The header wins over what the browser claims in Origin.
    assert.equal(requestIsHttps(headers({ 'x-forwarded-proto': 'http', origin: 'https://example.test' })), false)
  })

  it('falls back to the scheme of the Origin or Referer when the header is missing', () => {
    assert.equal(requestIsHttps(headers({ origin: 'https://example.test' })), true)
    assert.equal(requestIsHttps(headers({ origin: 'http://127.0.0.1:3000' })), false)
    assert.equal(requestIsHttps(headers({ referer: 'https://example.test/admin/login' })), true)
    assert.equal(requestIsHttps(headers({ referer: 'http://127.0.0.1:3000/admin/login' })), false)
    assert.equal(requestIsHttps(headers({ origin: 'null' })), false)
  })

  it('does not depend on NODE_ENV: `npm start` on plain http keeps working', async () => {
    // @types/node types NODE_ENV as read-only.
    const env = process.env as Record<string, string | undefined>
    const before = env.NODE_ENV
    env.NODE_ENV = 'production'
    try {
      assert.equal(requestIsHttps(headers({ 'x-forwarded-proto': 'http' })), false)
      assert.equal(requestIsHttps(headers({})), false)
      const { email } = await newAdmin()
      assert.equal((await (await client()).signInWithPassword({ email, password: PASSWORD })).error, null, 'sign-in works over plain http in production mode')
      assert.ok(jar().get(SESSION_COOKIE))
    } finally {
      if (before === undefined) delete env.NODE_ENV
      else env.NODE_ENV = before
    }
  })
})

describe('local session revocation', () => {
  it('a cookie from before sign-out, enrolment or the next sign-in is rejected; one without an epoch too', async () => {
    const { email, id } = await newAdmin()
    await fullSignIn(email)
    assert.equal((await (await client()).mfa.getAuthenticatorAssuranceLevel()).data.currentLevel, 'aal2')
    const stolen = jar().get(SESSION_COOKIE)!
    assert.ok(stolen)

    await (await client()).signOut()
    assert.equal(jar().has(SESSION_COOKIE), false)
    jar().set(SESSION_COOKIE, stolen)
    assert.equal((await (await client()).getUser()).data.user, null, 'stale epoch after sign-out')
    assert.equal((await (await client()).mfa.getAuthenticatorAssuranceLevel()).data.currentLevel, null)
    assert.equal((await row(id)).session_epoch, 3)

    // Enrolment start moves the epoch and re-signs this session; the old cookie dies.
    const { db } = { db: await getLocalDb() }
    await db.query('update local.admins set totp_factor_id = null, totp_secret = null, totp_verified = false where user_id = $1', [id])
    jar().clear()
    assert.equal((await (await client()).signInWithPassword({ email, password: PASSWORD })).error, null)
    const before = jar().get(SESSION_COOKIE)!
    assert.equal((await (await client()).mfa.enroll({ factorType: 'totp' })).error, null)
    assert.notEqual(jar().get(SESSION_COOKIE), before)
    assert.ok((await (await client()).getUser()).data.user, 'the re-signed session works')
    jar().set(SESSION_COOKIE, before)
    assert.equal((await (await client()).getUser()).data.user, null)

    // No epoch in the payload: invalid at once.
    const secret = authSecret()!
    const legacy = signSession({ uid: id, email, aal: 'aal2', exp: Math.floor(Date.now() / 1000) + 600 } as never, secret)
    assert.equal(verifySession(legacy, secret), null)
    jar().set(SESSION_COOKIE, legacy)
    assert.equal((await (await client()).getUser()).data.user, null)
  })
})

describe('local.admins schema upgrade', () => {
  it('adds the new columns to an existing database and keeps its admin and authenticator', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'social-local-auth-'))
    scratch.push(dir)
    const first = await openLocalDb(dir)
    const { rows } = await first.db.query<{ id: string }>('insert into auth.users (email) values ($1) returning id', ['old@example.test'])
    await first.db.query(
      `insert into local.admins (user_id, email, password_hash, totp_factor_id, totp_secret, totp_verified, totp_last_step)
       values ($1, 'old@example.test', 'scrypt$a$b', gen_random_uuid(), 'SECRET', true, 7)`,
      [rows[0].id]
    )
    await first.db.exec('alter table local.admins drop column failed_count, drop column locked_until, drop column session_epoch')
    await first.close()

    const again = await openLocalDb(dir)
    const admin = (await again.db.query<Record<string, unknown>>('select * from local.admins')).rows[0]
    assert.equal(admin.failed_count, 0)
    assert.equal(admin.session_epoch, 0)
    assert.equal(admin.locked_until, null)
    assert.equal(admin.totp_verified, true)
    assert.equal(admin.totp_secret, 'SECRET')
    await again.close()
    const third = await openLocalDb(dir) // idempotent
    await third.close()
  })
})
