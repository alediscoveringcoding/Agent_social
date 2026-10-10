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
  /** The user id (a uuid) of whoever ticked it; read the e-mail from verified_by_email. */
  verified_by: string | null
  /** The e-mail of whoever ticked it, from the activity log; null when unticked or not logged. */
  verified_by_email: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The sources of one post, in the order the generator listed them. */
export async function getPostSources(postId: string): Promise<PostSource[]> {
  if (!UUID.test(postId)) return []
  const db = createAdminClient()
  const { data, error } = await db
    .from('social_post_sources')
    .select('id, url, title, publisher, published_at, note, found_in_search, verified_at, verified_by')
    .eq('post_id', postId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw new Error(`social_post_sources: ${error.message}`)
  const sources = (data ?? []) as Array<Omit<PostSource, 'verified_by_email'>>

  // verified_by is a user id. The person's e-mail is in the activity log row that
  // social_set_source_verified writes when a source is ticked (details.source_id);
  // the newest such row is the current tick, because unticking clears verified_by.
  const emails = new Map<string, string>()
  if (sources.some((s) => s.verified_at)) {
    const log = await db
      .from('social_activity_log')
      .select('actor_email, details')
      .eq('post_id', postId)
      .eq('action', 'social.source_verified')
      .order('id', { ascending: false })
      .limit(1000)
    if (log.error) throw new Error(`social_activity_log: ${log.error.message}`)
    for (const row of (log.data ?? []) as Array<{ actor_email: string | null; details: unknown }>) {
      const sourceId = (row.details as { source_id?: unknown } | null)?.source_id
      if (typeof sourceId === 'string' && row.actor_email && !emails.has(sourceId)) emails.set(sourceId, row.actor_email)
    }
  }
  return sources.map((s) => ({ ...s, verified_by_email: s.verified_at ? (emails.get(s.id) ?? null) : null }))
}

/**
 * True while the revision has an active (not revoked) approval: the same
 * condition that freezes its post's sources in SQL (social_post_sources_frozen)
 * and that the post page reads as `post.approval`.
 */
export async function revisionHasActiveApproval(revisionId: string): Promise<boolean> {
  if (!UUID.test(revisionId)) return false
  const { data, error } = await createAdminClient()
    .from('social_approvals')
    .select('id')
    .eq('revision_id', revisionId)
    .is('revoked_at', null)
    .limit(1)
  if (error) throw new Error(`social_approvals: ${error.message}`)
  return (data ?? []).length > 0
}
