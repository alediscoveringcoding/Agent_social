import type { NativeContext } from './types.ts'

export type NativeErrorCode = 'AUTH_EXPIRED' | 'PERMISSION_DENIED' | 'RATE_LIMITED' | 'VALIDATION_REJECTED' | 'TEMPORARY_FAILURE' | 'UNKNOWN_RESULT' | 'INVALID_RESPONSE' | 'SETUP_REQUIRED'

/** Provider response bodies and request URLs may contain secrets; never retain them in errors. */
export class NativeProviderError extends Error {
  readonly code: NativeErrorCode
  readonly status: number
  readonly ambiguous: boolean
  readonly retryAfterSeconds?: number

  constructor(
    code: NativeErrorCode,
    status: number,
    ambiguous: boolean,
    retryAfterSeconds?: number,
  ) {
    super(`Native provider request failed: ${code}${status ? ` (${status})` : ''}`)
    this.name = 'NativeProviderError'
    this.code = code
    this.status = status
    this.ambiguous = ambiguous
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/** An explicit terminal processing status, rather than a failed lookup. */
export class NativeProcessingFailedError extends NativeProviderError {
  constructor() { super('VALIDATION_REJECTED', 422, false); this.name = 'NativeProcessingFailedError' }
}

export function retryAfterSeconds(value: string | null, now: Date): number | undefined {
  if (!value?.trim()) return undefined
  const clean = value.trim()
  if (/^\d+$/.test(clean)) return Math.min(Number(clean), 86_400)
  const until = Date.parse(clean)
  return Number.isFinite(until) ? Math.min(Math.max(0, Math.ceil((until - now.getTime()) / 1000)), 86_400) : undefined
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new Error('RESPONSE_TOO_LARGE')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let count = 0
  let result = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      count += value.byteLength
      if (count > maxBytes) {
        await reader.cancel()
        throw new Error('RESPONSE_TOO_LARGE')
      }
      result += decoder.decode(value, { stream: true })
    }
    return result + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export interface NativeHttpOptions extends Omit<RequestInit, 'body'> {
  body?: BodyInit | Record<string, unknown> | null
  /** A write may have succeeded even when its response was lost. */
  write?: boolean
  timeoutMs?: number
  maxResponseBytes?: number
  acceptStatuses?: number[]
}

export async function nativeRequest<T>(ctx: Pick<NativeContext, 'fetch' | 'now'>, url: string | URL, options: NativeHttpOptions = {}): Promise<{ data: T; response: Response }> {
  const { write = false, timeoutMs = 30_000, maxResponseBytes = 4_194_304, body, acceptStatuses = [], ...init } = options
  const headers = new Headers(init.headers)
  let encoded: BodyInit | null | undefined
  if (body !== undefined && body !== null && Object.getPrototypeOf(body) === Object.prototype) {
    headers.set('content-type', 'application/json')
    encoded = JSON.stringify(body)
  } else {
    encoded = body as BodyInit | null | undefined
  }
  const deadline = AbortSignal.timeout(timeoutMs)
  if (write && 'beforePublish' in ctx && typeof ctx.beforePublish === 'function') await ctx.beforePublish()
  let response: Response
  try {
    response = await ctx.fetch(url, { ...init, headers, body: encoded, redirect: 'error', signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline })
  } catch {
    throw new NativeProviderError(write ? 'UNKNOWN_RESULT' : 'TEMPORARY_FAILURE', 0, write)
  }
  if (!response.ok && !acceptStatuses.includes(response.status)) {
    await response.body?.cancel()
    const status = response.status
    if (status === 401) throw new NativeProviderError('AUTH_EXPIRED', status, false)
    if (status === 403) throw new NativeProviderError('PERMISSION_DENIED', status, false)
    if (status === 429) throw new NativeProviderError('RATE_LIMITED', status, false, retryAfterSeconds(response.headers.get('retry-after'), ctx.now()))
    if (status === 408 || status >= 500) throw new NativeProviderError(write ? 'UNKNOWN_RESULT' : 'TEMPORARY_FAILURE', status, write)
    throw new NativeProviderError('VALIDATION_REJECTED', status, false)
  }
  if (response.status === 204) return { data: null as T, response }
  try {
    const text = await readLimited(response, maxResponseBytes)
    return { data: (text.trim() ? JSON.parse(text) : null) as T, response }
  } catch {
    throw new NativeProviderError(write ? 'UNKNOWN_RESULT' : 'INVALID_RESPONSE', response.status, write)
  }
}

export function bearer(token: string): Record<string, string> {
  if (!token || /[\r\n]/.test(token)) throw new Error('NATIVE_CREDENTIALS_INVALID')
  return { authorization: `Bearer ${token}` }
}
