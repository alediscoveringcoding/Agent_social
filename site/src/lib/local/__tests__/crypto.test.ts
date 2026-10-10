import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  base32Decode,
  base32Encode,
  hashPassword,
  hotp,
  signSession,
  totpStep,
  verifyPassword,
  verifySession,
  verifyTotp,
} from '../crypto.ts'

// RFC 6238 appendix B, SHA-1: the ASCII secret "12345678901234567890".
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const SECRET = 'local-auth-secret-for-tests-0123456789'

describe('local mode crypto', () => {
  it('base32 round-trips and matches the RFC secret', () => {
    assert.equal(base32Encode(Buffer.from('12345678901234567890')), RFC_SECRET)
    assert.equal(base32Decode(RFC_SECRET).toString(), '12345678901234567890')
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255])
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes)
  })

  it('computes the RFC 6238 test vectors (6 digits)', () => {
    const key = base32Decode(RFC_SECRET)
    const vectors: Array<[number, string]> = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
    ]
    for (const [t, code] of vectors) assert.equal(hotp(key, totpStep(t * 1000)), code, `t=${t}`)
  })

  it('accepts the current code and one step of drift, once', () => {
    const key = base32Decode(RFC_SECRET)
    const now = 1111111111_000
    const step = totpStep(now)
    assert.equal(verifyTotp(RFC_SECRET, hotp(key, step), now, null), step)
    assert.equal(verifyTotp(RFC_SECRET, hotp(key, step - 1), now, null), step - 1)
    assert.equal(verifyTotp(RFC_SECRET, hotp(key, step - 2), now, null), null, 'two steps old')
    assert.equal(verifyTotp(RFC_SECRET, hotp(key, step), now, step), null, 'replay of a used step')
    assert.equal(verifyTotp(RFC_SECRET, '12345', now, null), null)
    assert.equal(verifyTotp(RFC_SECRET, 'abcdef', now, null), null)
  })

  it('hashes passwords with a salt and verifies them', async () => {
    const a = await hashPassword('correct horse battery')
    const b = await hashPassword('correct horse battery')
    assert.notEqual(a, b)
    assert.equal(await verifyPassword('correct horse battery', a), true)
    assert.equal(await verifyPassword('wrong horse battery', a), false)
    assert.equal(await verifyPassword('x', 'not-a-hash'), false)
  })

  it('signs sessions and refuses tampered, expired or unsigned ones', () => {
    const now = Date.now()
    const s = { uid: '00000000-0000-4000-8000-000000000001', email: 'a@example.test', aal: 'aal2' as const, epoch: 0, exp: Math.floor(now / 1000) + 60 }
    const token = signSession(s, SECRET)
    assert.deepEqual(verifySession(token, SECRET, now), s)
    assert.equal(verifySession(token, 'another-secret-another-secret-12345', now), null)
    const [payload, mac] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...s, aal: 'aal2', email: 'x@example.test' })).toString('base64url')
    assert.equal(verifySession(`${forged}.${mac}`, SECRET, now), null)
    assert.equal(verifySession(`${payload}.`, SECRET, now), null)
    assert.equal(verifySession(token, SECRET, now + 61_000), null, 'expired')
    assert.equal(verifySession(token, null, now), null, 'no secret configured')
    assert.equal(verifySession(undefined, SECRET, now), null)
  })
})
