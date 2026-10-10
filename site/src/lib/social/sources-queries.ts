import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * The web sources behind a draft (amendment 07), for the post and draft pages.
 * Written by the drafts route (social_add_post_sources); a person ticks
 * "Verificat" with setSourceVerified (sources-actions.ts). Approval waits
 * until every one is ticked.
 */

export interface PostSource {
  id: string
  url: string
  title: string
  publisher: string | null
  /** The date as the page gave it; free text, not parsed. */
  published_at: string | null
  /** What the source supports in the draft. */
  note: string | null
  /** true: the URL came back from the web search. */
  found_in_search: boolean
  verified_at: string | null
  verified_by: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The sources of one post, in the order the generator listed them. */
export async function getPostSources(postId: string): Promise<PostSource[]> {
  if (!UUID.test(postId)) return []
  const { data, error } = await createAdminClient()
    .from('social_post_sources')
    .select('id, url, title, publisher, published_at, note, found_in_search, verified_at, verified_by')
    .eq('post_id', postId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw new Error(`social_post_sources: ${error.message}`)
  return (data ?? []) as PostSource[]
}
