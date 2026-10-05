import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { getWorkerHealth, type WorkerHealth } from './accounts-queries.ts'
import type { AccountStatus, EventType, Platform } from './constants.ts'
import { listJobViews, type JobView } from './jobs-view.ts'
import { listDrafts, type DraftSummary } from './queries.ts'
import { addDays } from './calendar.ts'
import { bucharestDay, dayBoundsUtc } from './time.ts'

/**
 * The Overview (PRD F10, amendment 01 A10): approval queue, today and the
 * coming days, failures, manual handoffs due, accounts needing a person,
 * worker health and the social_events feed. Loading it runs the sweeper
 * (lease expiry, stale window, manual due, worker silence), as 0001 intends.
 */

export const UPCOMING_DAYS = 7

export interface OverviewEvent {
  id: number
  type: EventType
  payload: Record<string, unknown>
  created_at: string
  seen_at: string | null
}

export interface AttentionAccount {
  id: string
  platform: Platform
  display_name: string
  status: AccountStatus
  brand_id: string | null
  paused: boolean
  postiz_disabled: boolean
}

export interface Overview {
  now: string
  approvalQueue: DraftSummary[]
  today: JobView[]
  upcoming: JobView[]
  failures: JobView[]
  manualDue: JobView[]
  nextScheduled: JobView | null
  attention: AttentionAccount[]
  unassigned: number
  worker: WorkerHealth
  events: OverviewEvent[]
  unseen: number
  sweep: Record<string, unknown> | null
}

function must<T>(res: { data: unknown; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data as T
}

/** The event feed: unseen first-class, seen ones only when asked for. */
export async function listEvents(opts: { includeSeen?: boolean; limit?: number } = {}): Promise<{ events: OverviewEvent[]; unseen: number }> {
  const admin = createAdminClient()
  let q = admin.from('social_events').select('id, type, payload, created_at, seen_at')
  if (!opts.includeSeen) q = q.is('seen_at', null)
  const [events, unseen] = await Promise.all([
    q
      .order('id', { ascending: false })
      .limit(opts.limit ?? 50)
      .then((r) => must<OverviewEvent[]>(r, 'events') ?? []),
    admin
      .from('social_events')
      .select('id', { count: 'exact', head: true })
      .is('seen_at', null)
      .then((r) => {
        if (r.error) throw new Error(`events count: ${r.error.message}`)
        return r.count ?? 0
      }),
  ])
  return { events: events.map((e) => ({ ...e, id: Number(e.id) })), unseen }
}

export async function getOverview(opts: { includeSeen?: boolean; now?: Date } = {}): Promise<Overview> {
  const admin = createAdminClient()
  const now = opts.now ?? new Date()

  let sweep: Record<string, unknown> | null = null
  const swept = await admin.rpc('social_sweep', { p_now: now.toISOString() })
  if (swept.error) console.error('[social/overview] sweep failed:', swept.error.message)
  else sweep = swept.data as Record<string, unknown>

  const today = bucharestDay(now)
  const todayStart = dayBoundsUtc(today).start
  const tomorrowStart = dayBoundsUtc(addDays(today, 1)).start
  const horizon = dayBoundsUtc(addDays(today, UPCOMING_DAYS + 1)).start

  const [drafts, window, failed, manual, next, accounts, worker, feed] = await Promise.all([
    listDrafts(),
    listJobViews({ from: todayStart.toISOString(), to: horizon.toISOString(), excludeStatuses: ['cancelled'], limit: 300 }),
    listJobViews({ statuses: ['failed'], ascending: false, limit: 100 }),
    listJobViews({ statuses: ['manual_pending'], limit: 200 }),
    listJobViews({ statuses: ['queued', 'manual_pending'], from: now.toISOString(), limit: 1 }),
    admin
      .from('social_accounts')
      .select('id, platform, display_name, status, brand_id, paused, postiz_disabled')
      .order('platform')
      .then((r) => must<AttentionAccount[]>(r, 'accounts') ?? []),
    getWorkerHealth(now),
    listEvents({ includeSeen: opts.includeSeen }),
  ])

  const nowMs = now.getTime()
  return {
    now: now.toISOString(),
    approvalQueue: drafts,
    today: window.filter((j) => new Date(j.run_at).getTime() < tomorrowStart.getTime()),
    upcoming: window.filter((j) => new Date(j.run_at).getTime() >= tomorrowStart.getTime()),
    // What a person can still act on: the post's current revision, post not cancelled.
    failures: failed.filter((j) => j.is_current && j.post && !j.post.cancelled_at),
    manualDue: manual.filter((j) => new Date(j.run_at).getTime() <= nowMs),
    nextScheduled: next[0] ?? null,
    attention: accounts.filter(
      (a) => a.status === 'reconnect_required' || a.status === 'developer_setup_required' || (a.postiz_disabled && !a.paused)
    ),
    unassigned: accounts.filter((a) => !a.brand_id).length,
    worker,
    events: feed.events,
    unseen: feed.unseen,
    sweep,
  }
}
