import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import type { JobStatus, Platform, PostKind, PostStatus } from './constants.ts'

/**
 * Delivery jobs flattened with their destination, account and post, for the
 * Overview, the calendar and the manual handoff list (W3). One query with
 * to-one embeds; filters run on the job columns only.
 */

export interface JobView {
  id: string
  status: JobStatus
  run_at: string
  remote_url: string | null
  published_at: string | null
  attempts: number
  last_error_code: string | null
  last_error_message: string | null
  manual_done_at: string | null
  destination_id: string
  revision_id: string
  platform: Platform
  account: { id: string; display_name: string; platform: Platform; mode: 'auto' | 'manual'; status: string } | null
  post: {
    id: string
    title: string | null
    kind: PostKind
    status: PostStatus
    current_revision_id: string | null
    cancelled_at: string | null
    brand: { id: string; slug: string; name: string } | null
  } | null
  /** The job belongs to the post's current revision (retry and cancel act there). */
  is_current: boolean
}

interface JobRow extends Omit<JobView, 'destination_id' | 'revision_id' | 'platform' | 'post' | 'is_current'> {
  destination: {
    id: string
    platform: Platform
    revision_id: string
    revision: { post: JobView['post'] } | null
  } | null
}

export const JOB_VIEW_SELECT =
  'id, status, run_at, remote_url, published_at, attempts, last_error_code, last_error_message, manual_done_at, ' +
  'account:social_accounts(id, display_name, platform, mode, status), ' +
  'destination:social_destinations(id, platform, revision_id, revision:social_post_revisions(post:social_posts!social_post_revisions_post_id_fkey(id, title, kind, status, current_revision_id, cancelled_at, brand:social_brands(id, slug, name))))'

export function flattenJob(row: JobRow): JobView {
  const post = row.destination?.revision?.post ?? null
  return {
    id: row.id,
    status: row.status,
    run_at: row.run_at,
    remote_url: row.remote_url,
    published_at: row.published_at,
    attempts: row.attempts,
    last_error_code: row.last_error_code,
    last_error_message: row.last_error_message,
    manual_done_at: row.manual_done_at,
    destination_id: row.destination?.id ?? '',
    revision_id: row.destination?.revision_id ?? '',
    platform: row.destination?.platform ?? row.account?.platform ?? 'x',
    account: row.account,
    post,
    is_current: !!post && post.current_revision_id === row.destination?.revision_id,
  }
}

export interface JobFilter {
  statuses?: readonly JobStatus[]
  excludeStatuses?: readonly JobStatus[]
  from?: string
  to?: string
  ascending?: boolean
  limit?: number
}

/** Jobs by status and run_at window, flattened. */
export async function listJobViews(filter: JobFilter = {}): Promise<JobView[]> {
  const admin = createAdminClient()
  let q = admin.from('social_delivery_jobs').select(JOB_VIEW_SELECT)
  if (filter.statuses) q = q.in('status', filter.statuses as JobStatus[])
  for (const s of filter.excludeStatuses ?? []) q = q.neq('status', s)
  if (filter.from) q = q.gte('run_at', filter.from)
  if (filter.to) q = q.lt('run_at', filter.to)
  q = q.order('run_at', { ascending: filter.ascending !== false }).order('id')
  if (filter.limit) q = q.limit(filter.limit)
  const { data, error } = await q
  if (error) throw new Error(`jobs: ${error.message}`)
  return ((data ?? []) as unknown as JobRow[]).map(flattenJob)
}

/** One job, flattened, or null. */
export async function getJobView(jobId: string): Promise<JobView | null> {
  const admin = createAdminClient()
  const { data, error } = await admin.from('social_delivery_jobs').select(JOB_VIEW_SELECT).eq('id', jobId).maybeSingle()
  if (error) throw new Error(`job: ${error.message}`)
  return data ? flattenJob(data as unknown as JobRow) : null
}
