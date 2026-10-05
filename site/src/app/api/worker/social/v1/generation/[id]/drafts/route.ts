import { legalNamesFromEnv } from '@/lib/social/content-rules'
import { mapDraft, type BrandAccount } from '@/lib/social/draft-mapping'
import { DraftsBody } from '@/lib/social/schemas'
import { idRoute } from '@/lib/social/server/job-routes'
import { apiError, apiOk, fromTransition } from '@/lib/social/server/worker-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /generation/{id}/drafts {drafts: Draft[]} -> {created, skipped}
 *
 * Idempotent on request id + client_ref (`social_posts.generation_ref`, a
 * plain unique column): a re-delivered draft is skipped, never duplicated.
 * Marks the request done and emits `drafts_ready`. Drafts that fail the
 * content rules are stored anyway, with their validation, for a person to fix.
 */
export const POST = idRoute(DraftsBody, async (id, body, { workerId, admin }) => {
  const { data: state, error: stateError } = await admin.rpc('social_generation_lease_state', {
    p_request: id,
    p_worker_id: workerId,
  })
  if (stateError) throw new Error(`social_generation_lease_state: ${stateError.message}`)
  if (state === 'not_found') return apiError(404, 'NOT_FOUND', 'No such generation request')
  if (state !== 'ok' && state !== 'done') {
    return apiError(409, 'LEASE_LOST', `Request is ${state}; stop work on it`)
  }

  const { data: req, error: reqError } = await admin
    .from('social_generation_requests')
    .select('id, brand_id')
    .eq('id', id)
    .single()
  if (reqError || !req) throw new Error(`generation request: ${reqError?.message ?? 'missing'}`)
  const brandId = (req as { brand_id: string }).brand_id

  const { data: accounts, error: accError } = await admin
    .from('social_accounts')
    .select('id, platform, display_name, rules')
    .eq('brand_id', brandId)
    .order('created_at', { ascending: true })
  if (accError) throw new Error(`accounts: ${accError.message}`)

  const legalNames = legalNamesFromEnv(process.env.SOCIAL_LEGAL_NAMES)
  let created = 0
  let skipped = 0
  for (const draft of body.drafts) {
    const mapped = mapDraft(draft, (accounts ?? []) as BrandAccount[], { legalNames })
    const { data: postId, error } = await admin.rpc('social_create_post', {
      p_post: {
        brand_id: brandId,
        kind: mapped.post.kind,
        title: mapped.post.title,
        source_url: mapped.post.source_url,
        generation_request_id: id,
        generation_ref: `${id}:${draft.client_ref}`,
      },
      p_revision: mapped.revision,
      p_destinations: mapped.destinations,
    })
    if (error) throw new Error(`social_create_post (${draft.client_ref}): ${error.message}`)
    if (postId) created += 1
    else skipped += 1
  }

  const { data: finish, error: finishError } = await admin.rpc('social_generation_finish', {
    p_request: id,
    p_worker_id: workerId,
    p_created: created,
    p_skipped: skipped,
  })
  if (finishError) throw new Error(`social_generation_finish: ${finishError.message}`)
  const result = finish as Record<string, unknown> | null
  if (result?.ok !== true) return fromTransition(result)
  return apiOk({ created, skipped })
})
