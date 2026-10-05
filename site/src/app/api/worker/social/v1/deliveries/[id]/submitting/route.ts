import { AttemptBody } from '@/lib/social/schemas'
import { idRoute } from '@/lib/social/server/job-routes'
import { fromTransition, publishingEnabled } from '@/lib/social/server/worker-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /deliveries/{id}/submitting {attempt_no} -> 200 | 409
 *
 * Must succeed before the worker calls Postiz create. It is also the last
 * gate: past the stale window the job fails as STALE, and with the kill
 * switch off, a paused account or a revoked approval it goes back to the
 * queue. All of these answer 409, so the worker stops before Postiz.
 */
export const POST = idRoute(AttemptBody, async (id, body, { workerId, admin }) => {
  const { data, error } = await admin.rpc('social_job_submitting', {
    p_job: id,
    p_worker_id: workerId,
    p_attempt_no: body.attempt_no,
    p_enabled: publishingEnabled(),
  })
  if (error) throw new Error(`social_job_submitting: ${error.message}`)
  return fromTransition(data as Record<string, unknown> | null)
})
