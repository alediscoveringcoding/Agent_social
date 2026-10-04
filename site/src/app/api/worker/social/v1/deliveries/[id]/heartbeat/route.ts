import { AttemptBody } from '@/lib/social/schemas'
import { toHashTimestamp } from '@/lib/social/hash'
import { idRoute } from '@/lib/social/server/job-routes'
import { apiOk, fromTransition } from '@/lib/social/server/worker-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** POST /deliveries/{id}/heartbeat {attempt_no} -> {lease_expires_at}. Extends the lease by 10 minutes; 409 if lost. */
export const POST = idRoute(AttemptBody, async (id, body, { workerId, admin }) => {
  const { data, error } = await admin.rpc('social_job_heartbeat', {
    p_job: id,
    p_worker_id: workerId,
    p_attempt_no: body.attempt_no,
  })
  if (error) throw new Error(`social_job_heartbeat: ${error.message}`)
  const result = data as Record<string, unknown> | null
  if (result?.ok === true && typeof result.lease_expires_at === 'string') {
    return apiOk({ lease_expires_at: toHashTimestamp(result.lease_expires_at) })
  }
  return fromTransition(result)
})
