import type { Platform } from '../social/constants.ts'

export const NATIVE_PLATFORMS = [
  'facebook', 'instagram', 'linkedin-page', 'x', 'devto', 'hashnode',
  'threads', 'bluesky', 'mastodon', 'linkedin', 'reddit', 'pinterest',
  'telegram', 'discord', 'medium', 'farcaster', 'nostr', 'lemmy',
  'slack', 'wordpress', 'listmonk', 'vk', 'gmb', 'tumblr', 'dribbble',
  'mewe', 'skool', 'whop', 'moltbook', 'kick', 'twitch', 'tiktok', 'youtube', 'github', 'stackexchange',
] as const satisfies readonly Platform[]

export type NativePlatform = (typeof NATIVE_PLATFORMS)[number]
export type NativeSecrets = Record<string, string>
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export interface NativeCredentials {
  secrets: NativeSecrets
  expiresAt?: string
  scopes?: string[]
}

export interface NativeAccount {
  platform: NativePlatform
  remoteId: string
  displayName: string
  profileUrl?: string
  pictureUrl?: string
  metadata: JsonObject
  credentials: NativeCredentials
}

export interface NativeMedia {
  id: string
  mime: string
  bytes: number
  sha256: string
  altText: string
  width: number
  height: number
  filename: string
  durationSeconds?: number
}

export interface NativePublishInput {
  jobId: string
  attemptNo: number
  idempotencyKey: string
  account: NativeAccount
  text: string
  settings: JsonObject
  media: NativeMedia[]
  scheduledAt: string
}

export interface NativePublication {
  remoteId: string
  remoteUrl?: string
  status: 'published' | 'processing'
  metadata?: JsonObject
  /** Server encrypts upload-session capabilities before writing a checkpoint. */
  privateData?: NativeSecrets
}

export interface NativeMetrics {
  recordedAt: string
  values: Partial<Record<'views' | 'impressions' | 'reach' | 'likes' | 'comments' | 'shares' | 'clicks' | 'followers', number>>
  unavailable: string[]
}

/** All network and media access is supplied by the caller, including in tests. */
export interface NativeContext {
  fetch: typeof fetch
  now: () => Date
  readMedia: (media: NativeMedia) => Promise<Uint8Array>
  publicMediaUrl: (media: NativeMedia, options?: { jpeg?: boolean }) => Promise<string>
  checkpoint?: (publication: NativePublication) => Promise<void>
  beforePublish?: () => Promise<void>
}

export interface NativeConnectInput {
  credentials: NativeCredentials
  instanceUrl?: string
  destinationId?: string
}

export interface NativeProvider {
  platform: NativePlatform
  connect: (ctx: NativeContext, input: NativeConnectInput) => Promise<NativeAccount[]>
  publish: (ctx: NativeContext, input: NativePublishInput) => Promise<NativePublication>
  refresh?: (ctx: NativeContext, account: NativeAccount) => Promise<NativeCredentials>
  poll?: (ctx: NativeContext, account: NativeAccount, publication: NativePublication) => Promise<NativePublication>
  metrics?: (ctx: NativeContext, account: NativeAccount, remoteId?: string) => Promise<NativeMetrics>
  revoke?: (ctx: NativeContext, account: NativeAccount) => Promise<void>
}

export function isNativePlatform(value: unknown): value is NativePlatform {
  return typeof value === 'string' && (NATIVE_PLATFORMS as readonly string[]).includes(value)
}

export function requireSecret(account: NativeAccount | NativeCredentials, key: string): string {
  const credentials = 'credentials' in account ? account.credentials : account
  const value = credentials.secrets[key]
  if (!value?.trim()) throw new Error(`NATIVE_CREDENTIAL_REQUIRED:${key}`)
  return value
}

export function stringSetting(settings: JsonObject, key: string, fallback = ''): string {
  const value = settings[key]
  return typeof value === 'string' ? value : fallback
}

export function objectSetting(settings: JsonObject, key: string): JsonObject {
  const value = settings[key]
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}
