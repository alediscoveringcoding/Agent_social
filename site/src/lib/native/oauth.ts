import 'server-only'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { nativeRequest } from './http.ts'
import type { NativeContext, NativeCredentials } from './types.ts'

export interface OAuth2Config {
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  scopes: string[]
  pkce: boolean
  scopeSeparator?: string
  tokenAuthentication?: 'body' | 'basic'
  authorizeParameters?: Record<string, string>
  clientIdParameter?: 'client_id' | 'client_key'
}

export function stateHash(state: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new Error('NATIVE_OAUTH_STATE_INVALID')
  return createHash('sha256').update(state).digest('hex')
}

export function pkceChallenge(verifier: string): string {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new Error('NATIVE_OAUTH_VERIFIER_INVALID')
  return createHash('sha256').update(verifier).digest('base64url')
}

export function newOAuthAttempt(): { state: string; stateHash: string; verifier: string; browserBinding: string; browserHash: string } {
  const state = randomBytes(32).toString('base64url')
  const browserBinding = randomBytes(32).toString('base64url')
  return { state, stateHash: stateHash(state), verifier: randomBytes(48).toString('base64url'), browserBinding, browserHash: stateHash(browserBinding) }
}

export function sameOAuthBinding(binding: string, expectedHash: string): boolean {
  try {
    const actual = Buffer.from(stateHash(binding), 'hex')
    const expected = Buffer.from(expectedHash, 'hex')
    return expected.length === actual.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

function httpsEndpoint(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('NATIVE_OAUTH_ENDPOINT_INVALID')
  return url
}

function validateRedirect(value: string): void {
  const url = new URL(value)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.hash) throw new Error('NATIVE_OAUTH_REDIRECT_INVALID')
}

export function authorizationUrl(config: OAuth2Config, state: string, verifier: string): string {
  const url = httpsEndpoint(config.authorizeUrl)
  validateRedirect(config.redirectUri)
  stateHash(state)
  url.search = new URLSearchParams({
    ...config.authorizeParameters,
    [config.clientIdParameter ?? 'client_id']: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    state,
    scope: config.scopes.join(config.scopeSeparator ?? ' '),
    ...(config.pkce ? { code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256' } : {}),
  }).toString()
  return url.toString()
}

interface TokenResponse {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  scope?: unknown
  token_type?: unknown
}

export async function exchangeOAuthCode(ctx: Pick<NativeContext, 'fetch' | 'now'>, config: OAuth2Config, code: string, verifier: string): Promise<NativeCredentials> {
  httpsEndpoint(config.tokenUrl)
  validateRedirect(config.redirectUri)
  if (!code || code.length > 16_384) throw new Error('NATIVE_OAUTH_CODE_INVALID')
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri })
  const headers: Record<string, string> = {}
  if (config.tokenAuthentication === 'basic') {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret ?? '')}`).toString('base64')}`
  } else {
    form.set(config.clientIdParameter ?? 'client_id', config.clientId)
    if (config.clientSecret) form.set('client_secret', config.clientSecret)
  }
  if (config.pkce) {
    pkceChallenge(verifier)
    form.set('code_verifier', verifier)
  }
  const { data } = await nativeRequest<TokenResponse & { data?: TokenResponse[] }>(ctx, config.tokenUrl, { method: 'POST', headers, body: form })
  return tokenCredentials(data?.data?.[0] ?? data, ctx.now())
}

export function tokenCredentials(data: TokenResponse, now: Date): NativeCredentials {
  if (!data || typeof data.access_token !== 'string' || !data.access_token) throw new Error('NATIVE_OAUTH_TOKEN_INVALID')
  const credentials: NativeCredentials = { secrets: { accessToken: data.access_token } }
  if (typeof data.refresh_token === 'string' && data.refresh_token) credentials.secrets.refreshToken = data.refresh_token
  if (typeof data.token_type === 'string') credentials.secrets.tokenType = data.token_type
  const expires = Number(data.expires_in)
  if (Number.isFinite(expires) && expires > 0 && expires < 315_576_000) credentials.expiresAt = new Date(now.getTime() + expires * 1000).toISOString()
  if (typeof data.scope === 'string') credentials.scopes = data.scope.split(/[ ,]+/).filter(Boolean)
  return credentials
}

export async function refreshOAuthToken(ctx: Pick<NativeContext, 'fetch' | 'now'>, config: OAuth2Config, credentials: NativeCredentials): Promise<NativeCredentials> {
  httpsEndpoint(config.tokenUrl)
  const token = credentials.secrets.refreshToken
  if (!token) throw new Error('NATIVE_REFRESH_TOKEN_REQUIRED')
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token })
  const headers: Record<string, string> = {}
  if (config.tokenAuthentication === 'basic') headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret ?? '')}`).toString('base64')}`
  else {
    form.set(config.clientIdParameter ?? 'client_id', config.clientId)
    if (config.clientSecret) form.set('client_secret', config.clientSecret)
  }
  const { data } = await nativeRequest<TokenResponse>(ctx, config.tokenUrl, { method: 'POST', headers, body: form })
  const updated = tokenCredentials(data, ctx.now())
  updated.secrets.refreshToken ||= token
  updated.scopes ||= credentials.scopes
  return updated
}
