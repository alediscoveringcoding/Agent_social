import 'server-only'
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import type { NativeCredentials } from './types.ts'

const ALGORITHM = 'aes-256-gcm'
const MAX_BYTES = 131_072
const INVALID = 'NATIVE_CREDENTIALS_INVALID'
type EncryptionEnvironment = Readonly<Record<string, string | undefined>>

function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

function parseKey(value: string): Buffer {
  const clean = value.trim()
  if (/^[0-9a-f]{64}$/i.test(clean)) return Buffer.from(clean, 'hex')
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(clean)) throw new Error('NATIVE_CREDENTIALS_KEY_INVALID')
  const result = Buffer.from(clean, 'base64url')
  if (result.length !== 32) throw new Error('NATIVE_CREDENTIALS_KEY_INVALID')
  return result
}

/** Separate HKDF context means the local session secret is not used as an AES key. */
function currentKey(env: EncryptionEnvironment): Buffer {
  if (env.NATIVE_CREDENTIALS_KEY?.trim()) return parseKey(env.NATIVE_CREDENTIALS_KEY)
  if (env.DB_MODE === 'local' && (env.LOCAL_AUTH_SECRET?.length ?? 0) >= 32) {
    return Buffer.from(hkdfSync('sha256', env.LOCAL_AUTH_SECRET!, 'social-native-v1', 'credential-encryption', 32))
  }
  throw new Error('NATIVE_CREDENTIALS_KEY_REQUIRED')
}

function validateCredentials(value: unknown): NativeCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(INVALID)
  const candidate = value as Record<string, unknown>
  const secrets = candidate.secrets
  if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) throw new Error(INVALID)
  const entries = Object.entries(secrets)
  if (!entries.length || entries.length > 32) throw new Error(INVALID)
  for (const [key, secret] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || ['constructor', 'prototype'].includes(key)) throw new Error(INVALID)
    if (typeof secret !== 'string' || secret.length > 32_768) throw new Error(INVALID)
  }
  const result: NativeCredentials = { secrets: Object.fromEntries(entries) as Record<string, string> }
  if (candidate.expiresAt !== undefined) {
    if (typeof candidate.expiresAt !== 'string' || !Number.isFinite(Date.parse(candidate.expiresAt))) throw new Error(INVALID)
    result.expiresAt = new Date(candidate.expiresAt).toISOString()
  }
  if (candidate.scopes !== undefined) {
    if (!Array.isArray(candidate.scopes) || candidate.scopes.length > 100 || candidate.scopes.some((scope) => typeof scope !== 'string' || scope.length > 200)) throw new Error(INVALID)
    result.scopes = candidate.scopes as string[]
  }
  return result
}

function aad(context: string): Buffer {
  if (!context || context.length > 512) throw new Error('NATIVE_CREDENTIALS_CONTEXT_REQUIRED')
  return Buffer.from(`social-native-credentials:v1:${context}`, 'utf8')
}

export function sealCredentials(value: NativeCredentials, context: string, env: EncryptionEnvironment = process.env): string {
  const plaintext = Buffer.from(JSON.stringify(validateCredentials(value)), 'utf8')
  if (plaintext.length > MAX_BYTES) throw new Error(INVALID)
  const key = currentKey(env)
  const nonce = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, nonce)
  cipher.setAAD(aad(context))
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return ['v1', keyId(key), nonce.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
}

export function openCredentials(envelope: string, context: string, env: EncryptionEnvironment = process.env): NativeCredentials {
  if (typeof envelope !== 'string' || envelope.length > MAX_BYTES * 2) throw new Error(INVALID)
  const [version, id, nonceText, encryptedText, tagText, extra] = envelope.split('.')
  if (version !== 'v1' || !/^[0-9a-f]{16}$/.test(id ?? '') || !nonceText || !encryptedText || !tagText || extra !== undefined) throw new Error(INVALID)
  const candidates = [currentKey(env)]
  const previous = (env.NATIVE_CREDENTIALS_PREVIOUS_KEYS ?? '').split(',').map((key) => key.trim()).filter(Boolean)
  if (previous.length > 5) throw new Error('NATIVE_CREDENTIALS_KEY_INVALID')
  candidates.push(...previous.map(parseKey))
  const key = candidates.find((candidate) => keyId(candidate) === id)
  if (!key) throw new Error('NATIVE_CREDENTIALS_KEY_UNAVAILABLE')
  try {
    if (![nonceText, encryptedText, tagText].every((part) => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error(INVALID)
    const nonce = Buffer.from(nonceText, 'base64url')
    const tag = Buffer.from(tagText, 'base64url')
    if (nonce.length !== 12 || tag.length !== 16) throw new Error(INVALID)
    const decipher = createDecipheriv(ALGORITHM, key, nonce)
    decipher.setAAD(aad(context))
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(Buffer.from(encryptedText, 'base64url')), decipher.final()])
    if (plaintext.length > MAX_BYTES) throw new Error(INVALID)
    return validateCredentials(JSON.parse(plaintext.toString('utf8')))
  } catch {
    throw new Error(INVALID)
  }
}

export function credentialContext(platform: string, connectionId: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(platform) || !/^[a-zA-Z0-9:_-]{1,200}$/.test(connectionId)) throw new Error('NATIVE_CREDENTIALS_CONTEXT_REQUIRED')
  return `${platform}:${connectionId}`
}
