import { SubmittedBody } from '@/lib/social/schemas'
import { idRoute } from '@/lib/social/server/job-routes'
import { fromTransition } from '@/lib/social/server/worker-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /deliveries/{id}/submitted {attempt_no, postiz_post_id, postiz_group}
 *
 * Idempotent: the same IDs for the same attempt answer 200 again. Accepted
 * from `submitting` (normal) and `reconciling` (reconcile found the post);
 * the job then waits for a poll.
 */
export const POST = idRoute(SubmittedBody, async (id, body, { workerId, admin }) => {
  const { data, error } = await admin.rpc('social_job_submitted', {
    p_job: id,
    p_worker_id: workerId,
    p_attempt_no: body.attempt_no,
    p_postiz_post_id: body.postiz_post_id,
    p_postiz_group: body.postiz_group ?? null,
  })
  if (error) throw new Error(`social_job_submitted: ${error.message}`)
  return fromTransition(data as Record<string, unknown> | null)
})
