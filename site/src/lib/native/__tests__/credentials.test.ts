import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { credentialContext, openCredentials, sealCredentials } from '../credentials.ts'

const key = '11'.repeat(32)
const otherKey = '22'.repeat(32)
const env = { NATIVE_CREDENTIALS_KEY: key }
const credentials = { secrets: { accessToken: 'private-token', refreshToken: 'private-refresh' }, scopes: ['write'], expiresAt: '2030-01-01T00:00:00.000Z' }
const context = credentialContext('bluesky', 'connection-1')

describe('native credential encryption', () => {
  it('uses fresh authenticated ciphertext and round-trips credentials without exposing values', () => {
    const first = sealCredentials(credentials, context, env)
    const second = sealCredentials(credentials, context, env)
    assert.notEqual(first, second)
    assert.ok(!first.includes('private-token'))
    assert.deepEqual(openCredentials(first, context, env), credentials)
  })

  it('rejects ciphertext tampering and copying secrets to another account or platform', () => {
    const sealed = sealCredentials(credentials, context, env)
    const parts = sealed.split('.')
    const bytes = Buffer.from(parts[3], 'base64url')
    bytes[0] ^= 1
    parts[3] = bytes.toString('base64url')
    assert.throws(() => openCredentials(parts.join('.'), context, env), /NATIVE_CREDENTIALS_INVALID/)
    assert.throws(() => openCredentials(sealed, credentialContext('bluesky', 'connection-2'), env), /NATIVE_CREDENTIALS_INVALID/)
    assert.throws(() => openCredentials(sealed, credentialContext('mastodon', 'connection-1'), env), /NATIVE_CREDENTIALS_INVALID/)
  })

  it('supports explicit key rotation while new writes use the current key', () => {
    const old = sealCredentials(credentials, context, env)
    const rotated = { NATIVE_CREDENTIALS_KEY: otherKey, NATIVE_CREDENTIALS_PREVIOUS_KEYS: key }
    assert.deepEqual(openCredentials(old, context, rotated), credentials)
    const fresh = sealCredentials(credentials, context, rotated)
    assert.deepEqual(openCredentials(fresh, context, rotated), credentials)
    assert.throws(() => openCredentials(fresh, context, env), /KEY_UNAVAILABLE/)
  })

  it('derives a domain-separated local key and requires a configured key outside local mode', () => {
    const local = { DB_MODE: 'local', LOCAL_AUTH_SECRET: 'local-session-secret-'.repeat(3) }
    const sealed = sealCredentials(credentials, context, local)
    assert.deepEqual(openCredentials(sealed, context, local), credentials)
    assert.throws(() => sealCredentials(credentials, context, {}), /KEY_REQUIRED/)
    assert.throws(() => sealCredentials(credentials, context, { NATIVE_CREDENTIALS_KEY: 'short' }), /KEY_INVALID/)
  })

  it('rejects malformed and oversized secret containers', () => {
    assert.throws(() => sealCredentials({ secrets: {} }, context, env), /INVALID/)
    assert.throws(() => sealCredentials({ secrets: { accessToken: 'x'.repeat(40_000) } }, context, env), /INVALID/)
    assert.throws(() => openCredentials('not-an-envelope', context, env), /INVALID/)
    assert.throws(() => sealCredentials(credentials, '', env), /CONTEXT_REQUIRED/)
  })
})
