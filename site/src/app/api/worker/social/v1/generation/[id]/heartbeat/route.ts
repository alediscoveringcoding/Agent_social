import { z } from 'zod'
import { toHashTimestamp } from '@/lib/social/hash'
import { idRoute } from '@/lib/social/server/job-routes'
import { apiOk, fromTransition } from '@/lib/social/server/worker-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = idRoute(z.object({}), async (id, _body, { workerId, admin }) => {
  const { data, error } = await admin.rpc('social_generation_heartbeat', { p_request: id, p_worker_id: workerId })
  if (error) throw new Error(`social_generation_heartbeat: ${error.message}`)
  const result = data as Record<string, unknown> | null
  if (result?.ok === true && typeof result.lease_expires_at === 'string') {
    return apiOk({ lease_expires_at: toHashTimestamp(result.lease_expires_at) })
  }
  return fromTransition(result)
})
