import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { GenerationInputSchema } from '../schemas.ts'
import { apiError, constantTimeEqual } from './worker-http.ts'

export { apiError, apiOk, readBody } from './worker-http.ts'

/**
 * The automation API's door (PRD 10.4, amendment 07): `Authorization: Bearer
 * ${N8N_AUTOMATION_TOKEN}`, at least 32 characters, compared in constant time.
 * Unset or short means 503 (the site is not set up for n8n); a wrong or
 * missing token is 401.
 *
 * Same error body as the worker API: `{ "error": { "code", "message" } }`.
 *
 * What this door opens is small on purpose: create a generation request,
 * read the event outbox, log a run. It has no route that approves, schedules
 * or publishes anything (PRD D9); keep it that way.
 */

const MIN_TOKEN_LENGTH = 32

type Auth = { ok: true } | { ok: false; response: Response }

export function authenticateAutomation(request: Request): Auth {
  const token = process.env.N8N_AUTOMATION_TOKEN ?? ''
  if (token.length < MIN_TOKEN_LENGTH) {
    console.error('[social/automation] N8N_AUTOMATION_TOKEN is missing or shorter than 32 characters; refusing every call')
    return { ok: false, response: apiError(503, 'NOT_CONFIGURED', 'Automation API is not configured on this site') }
  }
  const header = request.headers.get('authorization') ?? ''
  if (!constantTimeEqual(header, `Bearer ${token}`)) {
    return { ok: false, response: apiError(401, 'UNAUTHORIZED', 'Invalid or missing bearer token') }
  }
  return { ok: true }
}

/** Authenticate, run the handler; any throw becomes a 500 with no internals in the body. */
export async function handleAutomationCall(
  request: Request,
  handler: (admin: SupabaseClient) => Promise<Response>
): Promise<Response> {
  const auth = authenticateAutomation(request)
  if (!auth.ok) return auth.response
  try {
    return await handler(createAdminClient())
  } catch (error) {
    console.error('[social/automation] %s %s failed:', request.method, new URL(request.url).pathname, error)
    return apiError(500, 'INTERNAL', 'Internal error')
  }
}

/** `workflow` names a workflow in n8n: lower case, digits, hyphens. */
const workflow = z.string().regex(/^[a-z0-9-]{1,64}$/, 'a-z, 0-9 and hyphens, 1-64 characters')
const eventId = z.string().min(1).max(200)

export const AutomationRequestBody = z.object({
  workflow,
  event_id: eventId,
  /** A brand slug, for example `taxes-support`. */
  brand: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'a brand slug').max(64),
  input: GenerationInputSchema,
})

export const AUTOMATION_RUN_STATUSES = ['ok', 'error', 'skipped'] as const

export const AutomationRunBody = z.object({
  workflow,
  event_id: eventId,
  status: z.enum(AUTOMATION_RUN_STATUSES),
  details: z
    .record(z.string(), z.unknown())
    .refine((d) => JSON.stringify(d).length <= 10_000, 'details is limited to 10000 characters of JSON')
    .optional(),
})

/** `GET /events` query: the cursor (last id seen, 0 = from the start) and the page size. */
export const AutomationEventsQuery = z.object({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(100),
})

/** The SQL exceptions the automation functions raise, as the HTTP answer they deserve. */
export function automationSqlError(message: string): Response | null {
  if (message.includes('SOCIAL_BRAND_NOT_FOUND')) return apiError(422, 'BRAND_NOT_FOUND', 'No brand with that slug')
  if (message.includes('SOCIAL_BAD_WORKFLOW')) return apiError(422, 'INVALID_BODY', 'workflow is not valid')
  if (message.includes('SOCIAL_BAD_EVENT_ID')) return apiError(422, 'INVALID_BODY', 'event_id is not valid')
  if (message.includes('SOCIAL_BAD_INPUT')) return apiError(422, 'INVALID_BODY', 'input or details is not valid')
  if (message.includes('SOCIAL_BAD_AUTOMATION_STATUS')) return apiError(422, 'INVALID_BODY', 'status is not valid')
  return null
}
