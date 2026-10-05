import { GenerationClaimBody } from '@/lib/social/schemas'
import { toHashTimestamp } from '@/lib/social/hash'
import { apiOk, handleWorkerCall, readBody } from '@/lib/social/server/worker-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ClaimedRequest {
  request_id: string
  brand: string
  input: unknown
  lease_expires_at: string
}

/**
 * POST /api/worker/social/v1/generation/claim {limit: 1}
 *   -> {requests: [{request_id, brand, input, lease_expires_at}]}
 *
 * Leased for 10 minutes; an expired lease goes back to the queue, three
 * attempts at most. Not affected by the kill switch: drafts publish nothing.
 */
export async function POST(request: Request) {
  return handleWorkerCall(request, async ({ workerId, admin }) => {
    const body = await readBody(request, GenerationClaimBody)
    if (!body.ok) return body.response

    const { data, error } = await admin.rpc('social_claim_generation', {
      p_worker_id: workerId,
      p_limit: body.data.limit ?? 1,
    })
    if (error) throw new Error(`social_claim_generation: ${error.message}`)

    const requests = ((data as { requests?: ClaimedRequest[] } | null)?.requests ?? []).map((r) => ({
      request_id: r.request_id,
      brand: r.brand,
      input: r.input,
      lease_expires_at: toHashTimestamp(r.lease_expires_at),
    }))
    return apiOk({ requests })
  })
}
