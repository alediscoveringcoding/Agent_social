import type { SupabaseClient } from '@supabase/supabase-js'
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
    // W2: local signed media URLs need the site's origin for worker downloads.
    let jobs: Awaited<ReturnType<typeof buildDeliveryJobs>>
    try {
      jobs = await buildDeliveryJobs(admin, claimed, { origin: new URL(request.url).origin })
    } catch (err) {
      // The jobs are leased to this worker but it will never see them: give them back now
      // rather than leaving them to sit out the 10 minute lease.
      await releaseClaimed(admin, workerId, publishIds(claimed))
      throw err
    }
    const built = new Set(jobs.map((j) => j.job_id))
    const skipped = publishIds(claimed.filter((c) => !built.has(c.job_id)))
    if (skipped.length > 0) await releaseClaimed(admin, workerId, skipped)
    return apiOk({ jobs })
  })
}

/**
 * social_release_deliveries puts this worker's claimed jobs back to queued without
 * counting the attempt. A failure here is logged and swallowed: the lease expiry
 * (sweeper) still frees the jobs, just later.
 */
async function releaseClaimed(admin: SupabaseClient, workerId: string, jobIds: string[]) {
  if (jobIds.length === 0) return
  try {
    const { error } = await admin.rpc('social_release_deliveries', { p_worker_id: workerId, p_job_ids: jobIds })
    if (error) console.error('[social/claim] could not release %d claimed job(s): %s', jobIds.length, error.message)
  } catch (err) {
    console.error('[social/claim] could not release %d claimed job(s):', jobIds.length, err)
  }
}

/** Only publish jobs are released: a poll or reconcile job is already past 'claimed' and must keep its status. */
function publishIds(jobs: ReadonlyArray<ClaimedJob>): string[] {
  return jobs.filter((c) => c.kind === 'publish').map((c) => c.job_id)
}
