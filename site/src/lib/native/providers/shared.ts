import { isIP } from 'node:net'
import { NativeProviderError } from '../http.ts'
import { stringSetting, type JsonObject, type NativeAccount, type NativeConnectInput, type NativeContext, type NativeMedia, type NativeMetrics, type NativePublishInput } from '../types.ts'

export function requiredString(value: unknown): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) throw new NativeProviderError('INVALID_RESPONSE', 200, false)
  return String(value)
}

export function publishedId(value: unknown): string {
  try { return requiredString(value) } catch { throw new NativeProviderError('UNKNOWN_RESULT', 200, true) }
}

export function publicHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    return url.href
  } catch { return undefined }
}

export function isPrivateAddress(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '')
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b))
  }
  if (isIP(host) === 6) {
    if (host.startsWith('::ffff:')) {
      const suffix = host.slice(7)
      if (isIP(suffix) === 4) return isPrivateAddress(suffix)
      const parts = suffix.split(':')
      if (parts.length === 2) {
        const a = Number.parseInt(parts[0], 16)
        const b = Number.parseInt(parts[1], 16)
        return isPrivateAddress(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`)
      }
    }
    return !/^[23]/.test(host) || host.startsWith('2001:db8:')
  }
  return false
}

/** Runtime fetch additionally checks DNS; this validates the configured URL itself. */
export function instanceUrl(value: string | undefined): string {
  const url = new URL(value ?? '')
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      isPrivateAddress(host) || host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal')) throw new Error('NATIVE_INSTANCE_URL_INVALID')
  return url.href.replace(/\/+$/, '')
}

export function accountInstance(account: NativeAccount): string {
  const url = account.metadata.instanceUrl
  return instanceUrl(typeof url === 'string' ? url : undefined)
}

export function requestedDestination(input: NativeConnectInput): string {
  return input.destinationId || input.credentials.secrets.destinationId || ''
}

export function titleOf(input: NativePublishInput): string {
  const title = stringSetting(input.settings, 'title').trim()
  if (!title) throw new NativeProviderError('VALIDATION_REJECTED', 422, false)
  return title
}

export function tagsOf(settings: JsonObject): string[] {
  const tags = settings.tags
  return (Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : typeof tags === 'string' ? tags.split(',') : []).map((tag) => tag.trim()).filter(Boolean)
}

export async function mediaBlob(ctx: NativeContext, media: NativeMedia): Promise<Blob> {
  const bytes = await ctx.readMedia(media)
  if (bytes.byteLength !== media.bytes) throw new Error('NATIVE_MEDIA_SIZE_MISMATCH')
  return new Blob([new Uint8Array(bytes)], { type: media.mime })
}

export function metricSnapshot(now: Date, values: Record<string, unknown>, names: Array<keyof NativeMetrics['values']>): NativeMetrics {
  const metrics: NativeMetrics = { recordedAt: now.toISOString(), values: {}, unavailable: [] }
  for (const name of names) {
    const value = values[name]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) metrics.values[name] = value
    else metrics.unavailable.push(name)
  }
  return metrics
}
