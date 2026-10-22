import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { nativeRequest, NativeProviderError, retryAfterSeconds } from '../http.ts'
import { authorizationUrl, exchangeOAuthCode, newOAuthAttempt, pkceChallenge, sameOAuthBinding } from '../oauth.ts'

const now = () => new Date('2030-01-01T00:00:00Z')
const config = { authorizeUrl: 'https://provider.example/authorize', tokenUrl: 'https://provider.example/token', clientId: 'example-client', redirectUri: 'http://localhost:3000/api/native/callback', scopes: ['read', 'write'], pkce: true }

describe('native provider HTTP safety', () => {
  it('treats lost and server-error write responses as ambiguous without leaking secrets', async () => {
    for (const fake of [async () => { throw new Error('secret-token-in-error') }, async () => new Response('secret-token-in-body', { status: 503 })]) {
      await assert.rejects(nativeRequest({ fetch: fake as typeof fetch, now }, 'https://provider.example/posts?token=private', { method: 'POST', write: true }), (error: unknown) => {
        assert.ok(error instanceof NativeProviderError)
        assert.equal(error.code, 'UNKNOWN_RESULT')
        assert.equal(error.ambiguous, true)
        assert.ok(!String(error).includes('secret-token'))
        assert.ok(!String(error).includes('private'))
        return true
      })
    }
  })

  it('distinguishes refresh, permission, rate-limit and definitive validation failures', async () => {
    for (const [status, code] of [[401, 'AUTH_EXPIRED'], [403, 'PERMISSION_DENIED'], [429, 'RATE_LIMITED'], [422, 'VALIDATION_REJECTED']] as const) {
      await assert.rejects(nativeRequest({ fetch: (async () => new Response('', { status, headers: { 'retry-after': '42' } })) as typeof fetch, now }, 'https://provider.example/posts', { write: true }), (error: unknown) => {
        assert.ok(error instanceof NativeProviderError)
        assert.equal(error.code, code)
        assert.equal(error.ambiguous, false)
        if (status === 429) assert.equal(error.retryAfterSeconds, 42)
        return true
      })
    }
    assert.equal(retryAfterSeconds('Tue, 01 Jan 2030 00:01:00 GMT', now()), 60)
    assert.equal(retryAfterSeconds('9999999', now()), 86_400)
  })

  it('rejects oversized or malformed success responses and disables redirects', async () => {
    let redirect: RequestRedirect | undefined
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => { redirect = init?.redirect; return new Response('not-json') }) as typeof fetch
    await assert.rejects(nativeRequest({ fetch: fake, now }, 'https://provider.example/posts', { write: true }), /UNKNOWN_RESULT/)
    assert.equal(redirect, 'error')
    await assert.rejects(nativeRequest({ fetch: (async () => new Response('x'.repeat(100))) as typeof fetch, now }, 'https://provider.example/me', { maxResponseBytes: 20 }), /INVALID_RESPONSE/)
  })
})

describe('native OAuth authorization', () => {
  it('uses the RFC 7636 S256 vector and binds fresh attempts to a browser nonce', () => {
    assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    const first = newOAuthAttempt()
    const second = newOAuthAttempt()
    assert.notEqual(first.state, second.state)
    assert.equal(sameOAuthBinding(first.browserBinding, first.browserHash), true)
    assert.equal(sameOAuthBinding(second.browserBinding, first.browserHash), false)
    assert.equal(sameOAuthBinding('invalid', first.browserHash), false)
    const url = new URL(authorizationUrl(config, first.state, first.verifier))
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(url.searchParams.get('code_challenge'), pkceChallenge(first.verifier))
    assert.equal(url.searchParams.get('state'), first.state)
  })

  it('exchanges the code through an injected client and records token expiry', async () => {
    const attempt = newOAuthAttempt()
    let sent: URLSearchParams | null = null
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent = init?.body as URLSearchParams
      return Response.json({ access_token: 'example-access', refresh_token: 'example-refresh', expires_in: 3600, scope: 'read write' })
    }) as typeof fetch
    const result = await exchangeOAuthCode({ fetch: fake, now }, config, 'authorization-code', attempt.verifier)
    assert.equal((sent as URLSearchParams | null)?.get('code_verifier'), attempt.verifier)
    assert.deepEqual(result, { secrets: { accessToken: 'example-access', refreshToken: 'example-refresh' }, expiresAt: '2030-01-01T01:00:00.000Z', scopes: ['read', 'write'] })
  })

  it('rejects insecure provider endpoints and non-local HTTP redirects', () => {
    const attempt = newOAuthAttempt()
    assert.throws(() => authorizationUrl({ ...config, authorizeUrl: 'http://provider.example/auth' }, attempt.state, attempt.verifier), /ENDPOINT_INVALID/)
    assert.throws(() => authorizationUrl({ ...config, redirectUri: 'http://public.example/callback' }, attempt.state, attempt.verifier), /REDIRECT_INVALID/)
  })
})
