import 'server-only'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * The worker API's door (PRD 10.3): `Authorization: Bearer ${WORKER_TOKEN}`,
 * compared in constant time, plus a stable `X-Worker-Id`. Every authenticated
 * call refreshes `social_workers.last_seen_at`, which is what the Overview's
 * "worker last seen" reads.
 *
 * Errors are `{ "error": { "code", "message" } }` with the HTTP status the
 * contract gives them; 409 always means "lease lost, stop work on this job".
 */

export interface WorkerContext {
  workerId: string
  version: string | null
  admin: SupabaseClient
}

const WORKER_ID = /^[A-Za-z0-9._:-]{1,64}$/
const MIN_TOKEN_LENGTH = 32

export function apiError(status: number, code: string, message: string, details?: unknown): Response {
  return Response.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status, headers: { 'Cache-Control': 'no-store' } }
  )
}

export function apiOk(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

/** Hash both sides first: equal-length buffers, and no length leaks through timing. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

/** `SOCIAL_PUBLISHING_ENABLED` must say exactly "true"; unset means stopped. */
export function publishingEnabled(): boolean {
  return process.env.SOCIAL_PUBLISHING_ENABLED === 'true'
}

type Auth = { ok: true; workerId: string; version: string | null } | { ok: false; response: Response }

export function authenticateWorker(request: Request): Auth {
  const token = process.env.WORKER_TOKEN ?? ''
  if (token.length < MIN_TOKEN_LENGTH) {
    console.error('[social/worker] WORKER_TOKEN is missing or shorter than 32 characters; refusing every call')
    return { ok: false, response: apiError(503, 'NOT_CONFIGURED', 'Worker API is not configured on this site') }
  }
  const header = request.headers.get('authorization') ?? ''
  if (!constantTimeEqual(header, `Bearer ${token}`)) {
    return { ok: false, response: apiError(401, 'UNAUTHORIZED', 'Invalid or missing bearer token') }
  }
  const workerId = request.headers.get('x-worker-id') ?? ''
  if (!WORKER_ID.test(workerId)) {
    return {
      ok: false,
      response: apiError(400, 'WORKER_ID_REQUIRED', 'X-Worker-Id is required: 1-64 characters of A-Z a-z 0-9 . _ : -'),
    }
  }
  const rawVersion = request.headers.get('x-worker-version')
  const version = rawVersion ? rawVersion.replace(/[^\x20-\x7e]/g, '').slice(0, 64) : null
  return { ok: true, workerId, version }
}

async function touchWorker(admin: SupabaseClient, workerId: string, version: string | null): Promise<void> {
  // `worker_id` is the primary key (a plain unique index), so this upsert is safe.
  const { error } = await admin
    .from('social_workers')
    .upsert({ worker_id: workerId, version, last_seen_at: new Date().toISOString() }, { onConflict: 'worker_id' })
  if (error) console.error('[social/worker] could not update last_seen_at:', error.message)
}

/**
 * Authenticate, record the call, run the handler; any throw becomes a 500
 * with no internals in the body (the worker logs the status, we log the cause).
 */
export async function handleWorkerCall(
  request: Request,
  handler: (ctx: WorkerContext) => Promise<Response>
): Promise<Response> {
  const auth = authenticateWorker(request)
  if (!auth.ok) return auth.response
  try {
    const admin = createAdminClient()
    await touchWorker(admin, auth.workerId, auth.version)
    return await handler({ workerId: auth.workerId, version: auth.version, admin })
  } catch (error) {
    console.error('[social/worker] %s %s failed:', request.method, new URL(request.url).pathname, error)
    return apiError(500, 'INTERNAL', 'Internal error')
  }
}

export async function readBody<S extends z.ZodType>(
  request: Request,
  schema: S
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: Response }> {
  let raw: unknown
  try {
    const text = await request.text()
    raw = text.trim() ? JSON.parse(text) : {}
  } catch {
    return { ok: false, response: apiError(400, 'INVALID_JSON', 'Body is not valid JSON') }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      response: apiError(
        422,
        'INVALID_BODY',
        'Body does not match the contract',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      ),
    }
  }
  return { ok: true, data: parsed.data }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID.test(value)
}

/** The `{ok, http, code, message}` answer of a social_* SQL function, as a response. */
export function fromTransition(result: Record<string, unknown> | null): Response {
  if (!result) return apiError(500, 'INTERNAL', 'No answer from the database')
  if (result.ok === true) {
    const { ok: _ok, ...rest } = result
    void _ok
    return apiOk({ ok: true, ...rest })
  }
  const status = typeof result.http === 'number' ? result.http : 500
  return apiError(status, String(result.code ?? 'ERROR'), String(result.message ?? 'Refused'))
}
