import 'server-only'
import { requireAdmin, type AdminIdentity } from '@/lib/auth/admin'
import { AdminAuthError } from '@/lib/auth/decision'

/**
 * The frame of a W3 server action (accounts, overview, manual handoff,
 * duplicate): requireAdmin() first, every time, then the body. A refusal the
 * person can act on comes back as {ok: false, error} in Romanian; anything
 * else is logged on the server and reported as a generic failure.
 */

export type ActionResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string }

/** A refusal with a message meant for the person (already in Romanian). */
export class ActionRefusal extends Error {}

/** An error raised by a social_* SQL function: `code` is its SOCIAL_* name. */
export class SqlFunctionError extends Error {
  readonly code: string
  readonly details: string | null
  constructor(code: string, message: string, details: string | null) {
    super(message)
    this.code = code
    this.details = details
  }
}

interface RpcClient {
  rpc(fn: string, params?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; details?: string | null } | null }>
}

/** Call a SQL function; a SOCIAL_* exception becomes a SqlFunctionError. */
export async function callRpc<T = unknown>(db: RpcClient, fn: string, params: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, params)
  if (error) {
    const code = /SOCIAL_[A-Z_]+/.exec(error.message)?.[0] ?? 'UNKNOWN'
    throw new SqlFunctionError(code, error.message, error.details ?? null)
  }
  return data as T
}

export type SqlMessages = Record<string, string | ((details: Record<string, unknown> | null) => string)>

function parseDetails(details: string | null): Record<string, unknown> | null {
  if (!details) return null
  try {
    const v = JSON.parse(details)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function runAdminAction<T extends object>(
  label: string,
  messages: SqlMessages,
  body: (actor: AdminIdentity) => Promise<ActionResult<T>>
): Promise<ActionResult<T>> {
  try {
    return await body(await requireAdmin())
  } catch (e) {
    if (e instanceof AdminAuthError || e instanceof ActionRefusal) return { ok: false, error: e.message }
    if (e instanceof SqlFunctionError && messages[e.code]) {
      const m = messages[e.code]
      return { ok: false, error: typeof m === 'function' ? m(parseDetails(e.details)) : m }
    }
    console.error(`[social/${label}] failed:`, e)
    return { ok: false, error: 'Ceva nu a mers. Incearca din nou; daca se repeta, verifica jurnalul serverului.' }
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}
