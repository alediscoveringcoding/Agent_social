import { ResultBody } from '@/lib/social/schemas'
import { idRoute } from '@/lib/social/server/job-routes'
import { fromTransition } from '@/lib/social/server/worker-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /deliveries/{id}/result
 *   {attempt_no, outcome, remote_url?, error_code?, error_message?, retry_after_seconds?}
 *
 * outcome: published | failed | retry | reconciling | not_found (PRD 10.2,
 * 10.7). `retry` backs off 1 / 5 / 15 min (or retry_after_seconds) up to 3
 * attempts; AUTH_EXPIRED and PERMISSION_DENIED also mark the account; the
 * first `not_found` re-queues, the second fails RECONCILE_MISS. Repeating
 * the same final report answers 200 with `idempotent: true`.
 */
export const POST = idRoute(ResultBody, async (id, body, { workerId, admin }) => {
  const { data, error } = await admin.rpc('social_job_result', {
    p_job: id,
    p_worker_id: workerId,
    p_attempt_no: body.attempt_no,
    p_outcome: body.outcome,
    p_remote_url: body.remote_url ?? null,
    p_error_code: body.error_code ?? null,
    p_error_message: body.error_message ?? null,
    p_retry_after_seconds: body.retry_after_seconds ?? null,
  })
  if (error) throw new Error(`social_job_result: ${error.message}`)
  return fromTransition(data as Record<string, unknown> | null)
})
