import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The server singleton (getLocalDb) and the session client read these.
const serverDir = mkdtempSync(join(tmpdir(), 'social-local-db-'))
process.env.LOCAL_DB_DIR = serverDir
process.env.LOCAL_AUTH_SECRET = 'local-auth-secret-for-tests-0123456789'

const { LocalDbInUseError, getLocalDb, openLocalDb } = await import('../db.ts')
const { base32Decode, hashPassword, hotp, totpStep } = await import('../crypto.ts')
const { createLocalSessionClient } = await import('../session-client.ts')

const scratch: string[] = [serverDir]
after(async () => {
  await (await getLocalDb()).close()
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
})

describe('local mode database', () => {
  it('builds the schema from the migrations once, then applies only new ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'social-local-db-'))
    scratch.push(dir)
    const first = await openLocalDb(dir)
    assert.deepEqual(first.applied, ['0001_social_publishing.sql', '0002_social_activity_log.sql'])
    const brands = await first.db.query<{ slug: string }>('select slug from social_brands order by slug')
    assert.deepEqual(brands.rows.map((r) => r.slug), ['comets-of-web3', 'taxes-support', 'the-crypto-support'])
    await first.close()

    const again = await openLocalDb(dir)
    assert.deepEqual(again.applied, [], 'data and migration log persist on disk')
    assert.equal((await again.db.query('select 1 from social_brands')).rows.length, 3)
    await again.close()
  })

  it('refuses a second process instead of sharing the files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'social-local-db-'))
    scratch.push(dir)
    // The parent of the test runner is alive and is not us.
    writeFileSync(join(dir, 'owner.pid'), String(process.ppid))
    await assert.rejects(openLocalDb(dir), LocalDbInUseError)
    // A stale owner (a pid that is gone) is taken over.
    writeFileSync(join(dir, 'owner.pid'), '999999999')
    const db = await openLocalDb(dir)
    await db.close()
  })
})

describe('local mode login (Supabase Auth stand-in)', () => {
  it('password -> aal1, authenticator enrol + code -> aal2, codes work once, sign out', async () => {
    const db = await getLocalDb()
    const email = 'admin@example.test'
    const password = 'a-long-local-password'
    const { rows } = await db.query<{ id: string }>('insert into auth.users (email) values ($1) returning id', [email])
    await db.query('insert into local.admins (user_id, email, password_hash) values ($1, $2, $3)', [rows[0].id, email, await hashPassword(password)])

    let auth = (await createLocalSessionClient()).auth
    assert.ok((await auth.signInWithPassword({ email, password: 'wrong-password-123' })).error)
    assert.equal((await auth.getUser()).data.user, null)
    assert.equal((await auth.signInWithPassword({ email: ' Admin@Example.test ', password })).error, null)

    auth = (await createLocalSessionClient()).auth
    const user = (await auth.getUser()).data.user!
    assert.equal(user.email, email)
    assert.deepEqual(user.factors, [])
    assert.equal((await auth.mfa.getAuthenticatorAssuranceLevel()).data.currentLevel, 'aal1')

    const enrolled = await auth.mfa.enroll({ factorType: 'totp' })
    assert.equal(enrolled.error, null)
    const { id: factorId, totp } = enrolled.data!
    assert.match(totp.secret, /^[A-Z2-7]{32}$/)
    assert.match(totp.uri, /^otpauth:\/\/totp\//)
    assert.deepEqual((await auth.mfa.listFactors()).data.all.map((f) => f.status), ['unverified'])

    const code = hotp(base32Decode(totp.secret), totpStep(Date.now()))
    const wrong = String((Number(code) + 500_000) % 1_000_000).padStart(6, '0')
    assert.ok((await auth.mfa.challengeAndVerify({ factorId, code: wrong })).error)
    assert.equal((await auth.mfa.challengeAndVerify({ factorId, code })).error, null)

    auth = (await createLocalSessionClient()).auth
    assert.equal((await auth.mfa.getAuthenticatorAssuranceLevel()).data.currentLevel, 'aal2')
    assert.deepEqual((await auth.getUser()).data.user!.factors.map((f) => f.status), ['verified'])
    assert.ok((await auth.mfa.challengeAndVerify({ factorId, code })).error, 'a used code is refused')
    assert.ok((await auth.mfa.enroll({ factorType: 'totp' })).error, 'no second enrolment once verified')

    await auth.signOut()
    auth = (await createLocalSessionClient()).auth
    assert.equal((await auth.getUser()).data.user, null)
  })
})
