import { ClaimBody } from '@/lib/social/schemas'
import { buildDeliveryJobs, type ClaimedJob } from '@/lib/social/server/delivery-payload'
import { apiOk, handleWorkerCall, publishingEnabled, readBody } from '@/lib/social/server/worker-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/worker/social/v1/deliveries/claim  {limit<=5} -> {jobs: DeliveryJob[]}
 *
 * Due publish jobs, then reconcile and poll jobs, leased for 10 minutes. The
 * claim function runs the sweeper first (lease expiry, STALE) and enforces the
 * daily cap and stale window. With SOCIAL_PUBLISHING_ENABLED other than
 * "true" it returns no jobs at all.
 */
export async function POST(request: Request) {
  return handleWorkerCall(request, async ({ workerId, admin }) => {
    const body = await readBody(request, ClaimBody)
    if (!body.ok) return body.response

    const { data, error } = await admin.rpc('social_claim_deliveries', {
      p_worker_id: workerId,
      p_limit: body.data.limit ?? 1,
      p_enabled: publishingEnabled(),
    })
    if (error) throw new Error(`social_claim_deliveries: ${error.message}`)

    const claimed = ((data as { jobs?: ClaimedJob[] } | null)?.jobs ?? []) as ClaimedJob[]
    return apiOk({ jobs: await buildDeliveryJobs(admin, claimed) })
  })
}
