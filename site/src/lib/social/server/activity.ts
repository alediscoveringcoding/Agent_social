import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface ActivityEntry {
  action: string
  status?: 'success' | 'error'
  postId?: string | null
  jobId?: string | null
  accountId?: string | null
  details?: Record<string, unknown>
}

/**
 * One row in social_activity_log (amendment 02). Never throws: a failed log
 * write is reported on the server console, and the action it describes stands.
 */
export async function logActivity(
  admin: SupabaseClient,
  actor: { userId: string; email: string } | null,
  entry: ActivityEntry
): Promise<void> {
  try {
    const { error } = await admin.from('social_activity_log').insert({
      actor_id: actor?.userId ?? null,
      actor_email: actor?.email ?? null,
      action: entry.action,
      status: entry.status ?? 'success',
      post_id: entry.postId ?? null,
      job_id: entry.jobId ?? null,
      account_id: entry.accountId ?? null,
      details: entry.details ?? {},
    })
    if (error) console.error('[social/activity] could not log %s: %s', entry.action, error.message)
  } catch (e) {
    console.error('[social/activity] could not log %s:', entry.action, e)
  }
}
