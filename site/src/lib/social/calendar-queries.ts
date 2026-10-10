import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { dayLengthHours, groupByDay, weekBoundsUtc, weekDays } from './calendar.ts'
import type { JobStatus, Platform, PostStatus } from './constants.ts'
import { listJobViews } from './jobs-view.ts'

/**
 * The calendar week (PRD F10): every delivery job with its slot in the week,
 * plus the times already set on drafts that are not approved yet, grouped by
 * Bucharest day.
 */

export interface CalendarEntry {
  key: string
  kind: 'job' | 'draft'
  at: string
  status: JobStatus | 'draft'
  platform: Platform
  account: string
  account_mode: 'auto' | 'manual' | null
  job_id: string | null
  post_id: string | null
  post_status: PostStatus | null
  title: string | null
  brand: string | null
  remote_url: string | null
  error_code: string | null
}

export interface CalendarDay {
  day: string
  hours: number
  entries: CalendarEntry[]
}

export interface CalendarWeek {
  monday: string
  days: CalendarDay[]
  total: number
}

interface DraftDestinationRow {
  id: string
  platform: Platform
  scheduled_at: string
  revision_id: string
  account: { display_name: string; mode: 'auto' | 'manual' } | null
  revision: {
    post: {
      id: string
      title: string | null
      status: PostStatus
      current_revision_id: string | null
      cancelled_at: string | null
      brand: { name: string } | null
    } | null
  } | null
}

/**
 * Scheduled destinations of the current revision of each live draft post in
 * the window. The current revisions are picked first, so old revisions never
 * crowd the limit out.
 */
async function draftDestinations(admin: ReturnType<typeof createAdminClient>, from: string, to: string): Promise<DraftDestinationRow[]> {
  const posts = await admin.from('social_posts').select('id, current_revision_id').eq('status', 'draft').is('cancelled_at', null).limit(2000)
  if (posts.error) throw new Error(`posts: ${posts.error.message}`)
  const revisionIds = ((posts.data ?? []) as Array<{ current_revision_id: string | null }>).map((p) => p.current_revision_id).filter((id): id is string => !!id)
  const out: DraftDestinationRow[] = []
  for (let i = 0; i < revisionIds.length; i += 100) {
    const r = await admin
      .from('social_destinations')
      .select(
        'id, platform, scheduled_at, revision_id, account:social_accounts(display_name, mode), revision:social_post_revisions(post:social_posts!social_post_revisions_post_id_fkey(id, title, status, current_revision_id, cancelled_at, brand:social_brands(name)))'
      )
      .in('revision_id', revisionIds.slice(i, i + 100))
      .gte('scheduled_at', from)
      .lt('scheduled_at', to)
      .order('scheduled_at')
      .limit(500)
    if (r.error) throw new Error(`destinations: ${r.error.message}`)
    out.push(...((r.data ?? []) as unknown as DraftDestinationRow[]))
  }
  return out.sort((x, y) => (x.scheduled_at < y.scheduled_at ? -1 : x.scheduled_at > y.scheduled_at ? 1 : 0)).slice(0, 500)
}

export async function getCalendarWeek(monday: string, opts: { cancelled?: boolean } = {}): Promise<CalendarWeek> {
  const admin = createAdminClient()
  const { start, end } = weekBoundsUtc(monday)
  const [jobs, drafts] = await Promise.all([
    listJobViews({
      from: start.toISOString(),
      to: end.toISOString(),
      excludeStatuses: opts.cancelled ? [] : ['cancelled'],
      limit: 500,
    }),
    draftDestinations(admin, start.toISOString(), end.toISOString()),
  ])

  const entries: CalendarEntry[] = jobs.map((j) => ({
    key: `job-${j.id}`,
    kind: 'job',
    at: j.run_at,
    status: j.status,
    platform: j.platform,
    account: j.account?.display_name ?? '-',
    account_mode: j.account?.mode ?? null,
    job_id: j.id,
    post_id: j.post?.id ?? null,
    post_status: j.post?.status ?? null,
    title: j.post?.title ?? null,
    brand: j.post?.brand?.name ?? null,
    remote_url: j.remote_url,
    error_code: j.last_error_code,
  }))

  for (const d of drafts) {
    const post = d.revision?.post
    // Only the current revision of a live, not yet approved post: an approved
    // one is on the calendar through its jobs.
    if (!post || post.status !== 'draft' || post.cancelled_at || post.current_revision_id !== d.revision_id) continue
    entries.push({
      key: `draft-${d.id}`,
      kind: 'draft',
      at: d.scheduled_at,
      status: 'draft',
      platform: d.platform,
      account: d.account?.display_name ?? '-',
      account_mode: d.account?.mode ?? null,
      job_id: null,
      post_id: post.id,
      post_status: post.status,
      title: post.title,
      brand: post.brand?.name ?? null,
      remote_url: null,
      error_code: null,
    })
  }

  const days = weekDays(monday)
  const byDay = groupByDay(entries, days, (e) => e.at)
  return {
    monday,
    days: days.map((day) => ({ day, hours: dayLengthHours(day), entries: byDay.get(day) ?? [] })),
    total: entries.length,
  }
}
