import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  ACCOUNT_SYNC_WARN_MINUTES,
  WORKER_SEEN_WARN_MINUTES,
  freshness,
  type AccountMode,
  type Freshness,
} from './accounts.ts'
import type { AccountStatus, Platform } from './constants.ts'
import { publishingEnabled } from './server/worker-http.ts'

/**
 * Reads for the accounts screen and the worker health box (PRD F1, A10).
 * Callers have passed requireAdminPage() / requireAdmin(). Plain JSON shapes.
 */

export interface AdminBrand {
  id: string
  slug: string
  name: string
}

export interface AdminAccount {
  id: string
  brand_id: string | null
  brand: AdminBrand | null
  platform: Platform
  mode: AccountMode
  status: AccountStatus
  postiz_integration_id: string | null
  postiz_provider: string | null
  postiz_disabled: boolean
  display_name: string
  picture_url: string | null
  profile_url: string | null
  open_editor_url: string | null
  daily_cap: number
  paused: boolean
  last_synced_at: string | null
  created_at: string
  updated_at: string
  /** Jobs not yet out or still waiting for a person (queued ... manual_pending). */
  open_jobs: number
  /** Destinations that use the account (any revision); a used account cannot be deleted. */
  used: boolean
}

export interface WorkerHealth {
  workers: Array<{ worker_id: string; version: string | null; last_seen_at: string; last_account_sync_at: string | null }>
  last_seen_at: string | null
  last_account_sync_at: string | null
  seen: Freshness
  sync: Freshness
  publishing_enabled: boolean
}

const OPEN_JOB_STATUSES = ['queued', 'claimed', 'submitting', 'submitted', 'reconciling', 'manual_pending']

function must<T>(res: { data: unknown; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data as T
}

export async function listBrandsForAccounts(): Promise<AdminBrand[]> {
  const admin = createAdminClient()
  return must<AdminBrand[]>(await admin.from('social_brands').select('id, slug, name').order('name'), 'brands') ?? []
}

export async function listAdminAccounts(): Promise<AdminAccount[]> {
  const admin = createAdminClient()
  const [accounts, jobs] = await Promise.all([
    admin
      .from('social_accounts')
      .select(
        'id, brand_id, brand:social_brands(id, slug, name), platform, mode, status, postiz_integration_id, postiz_provider, postiz_disabled, display_name, picture_url, profile_url, open_editor_url, daily_cap, paused, last_synced_at, created_at, updated_at'
      )
      .order('platform')
      .order('display_name')
      .then((r) => must<Array<Omit<AdminAccount, 'open_jobs' | 'used'>>>(r, 'accounts') ?? []),
    admin
      .from('social_delivery_jobs')
      .select('account_id')
      .in('status', OPEN_JOB_STATUSES)
      .then((r) => must<Array<{ account_id: string }>>(r, 'open jobs') ?? []),
  ])
  const open = new Map<string, number>()
  for (const j of jobs) open.set(j.account_id, (open.get(j.account_id) ?? 0) + 1)

  // "In use" matters only where deleting is offered: manual-only accounts.
  const manual = accounts.filter((a) => !a.postiz_integration_id)
  const used = new Set<string>()
  await Promise.all(
    manual.map(async (a) => {
      const { count, error } = await admin
        .from('social_destinations')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', a.id)
      if (error) throw new Error(`destinations: ${error.message}`)
      if ((count ?? 0) > 0) used.add(a.id)
    })
  )

  return accounts.map((a) => ({
    ...a,
    open_jobs: open.get(a.id) ?? 0,
    used: a.postiz_integration_id ? true : used.has(a.id) || (open.get(a.id) ?? 0) > 0,
  }))
}

export async function getWorkerHealth(now: Date = new Date()): Promise<WorkerHealth> {
  const admin = createAdminClient()
  const workers =
    must<WorkerHealth['workers']>(
      await admin
        .from('social_workers')
        .select('worker_id, version, last_seen_at, last_account_sync_at')
        .order('last_seen_at', { ascending: false })
        .limit(20),
      'workers'
    ) ?? []
  const latest = (xs: Array<string | null>) =>
    xs.filter((x): x is string => !!x).sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null
  const lastSeen = latest(workers.map((w) => w.last_seen_at))
  const lastSync = latest(workers.map((w) => w.last_account_sync_at))
  return {
    workers,
    last_seen_at: lastSeen,
    last_account_sync_at: lastSync,
    seen: freshness(lastSeen, now, WORKER_SEEN_WARN_MINUTES),
    sync: freshness(lastSync, now, ACCOUNT_SYNC_WARN_MINUTES),
    publishing_enabled: publishingEnabled(),
  }
}
