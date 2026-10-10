import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Amendment 07: did this post come from a request that searched the web? Such a
 * post needs at least one source before approval (migration 0013 checks it too).
 */
export async function postAskedForResearch(postId: string): Promise<boolean> {
  if (!UUID.test(postId)) return false
  const db = createAdminClient()
  const { data: post, error } = await db.from('social_posts').select('generation_request_id').eq('id', postId).maybeSingle()
  if (error) throw new Error(error.message)
  const requestId = (post as { generation_request_id: string | null } | null)?.generation_request_id
  if (!requestId) return false
  const { data: request, error: requestError } = await db
    .from('social_generation_requests')
    .select('input')
    .eq('id', requestId)
    .maybeSingle()
  if (requestError) throw new Error(requestError.message)
  const input = (request as { input: { research?: unknown; source?: { type?: unknown } } | null } | null)?.input
  return input?.research === true || input?.source?.type === 'news'
}
