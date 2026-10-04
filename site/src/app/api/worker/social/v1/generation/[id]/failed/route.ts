import { GenerationFailedBody } from '@/lib/social/schemas'
import { idRoute } from '@/lib/social/server/job-routes'
import { fromTransition } from '@/lib/social/server/worker-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /generation/{id}/failed {error_code, error_message} -> 200 | 409. Emits `generation_failed`. */
export const POST = idRoute(GenerationFailedBody, async (id, body, { workerId, admin }) => {
  const { data, error } = await admin.rpc('social_generation_fail', {
    p_request: id,
    p_worker_id: workerId,
    p_error_code: body.error_code,
    p_error_message: body.error_message ?? null,
  })
  if (error) throw new Error(`social_generation_fail: ${error.message}`)
  return fromTransition(data as Record<string, unknown> | null)
})
