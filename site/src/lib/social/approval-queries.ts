import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import type { JobStatus, Platform, PostKind, PostStatus } from './constants.ts'
import type { ApprovalAccount, ApprovalDestination, ApprovalMedia } from './approval.ts'
import type { StoredValidation } from './draft-mapping.ts'
import type { DraftFigure } from './figures.ts'
import type { Brand } from './queries.ts'
import type { BookedJob } from './slots.ts'

/**
 * Reads for approval and scheduling (W1): the posts list, one post with its
 * destinations, jobs and approvals, and what the cap and "suggest slot" count.
 * Service-role client; callers have passed requireAdminPage() / requireAdmin().
 * Shapes are plain JSON so they can go straight to client components.
 */

type Db = ReturnType<typeof createAdminClient>

/** Job states that count against the daily cap (PRD 5; social_cap_usage). */
export const CAP_COUNTED_STATUSES = [
  'queued',
  'claimed',
  'submitting',
  'submitted',
  'reconciling',
  'published',
  'manual_pending',
  'manual_done',
] as const satisfies readonly JobStatus[]

/** A job that has left (or may have left) for the platform: it stays with its revision. */
export const SENT_STATUSES = ['submitting', 'submitted', 'reconciling', 'published', 'manual_done'] as const satisfies readonly JobStatus[]

/** Jobs an admin may cancel (PRD 10.2). */
export const CANCELLABLE_STATUSES = ['queued', 'claimed', 'manual_pending'] as const satisfies readonly JobStatus[]

function must<T>(res: { data: unknown; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return (res.data ?? null) as T
}

export interface PostJob {
  id: string
  destination_id: string
  revision_id: string
  revision_number: number
  account_id: string
  platform: Platform
  account_name: string
  status: JobStatus
  run_at: string
  attempts: number
  remote_url: string | null
  published_at: string | null
  last_error_code: string | null
  last_error_message: string | null
  manual_done_at: string | null
  cancelled_at: string | null
}

export interface PostDestinationView {
  id: string
  account_id: string
  platform: Platform
  account: ApprovalAccount
  text: string
  settings: Record<string, unknown>
  scheduled_at: string | null
  contains_figures: boolean
  figures: ReadonlyArray<DraftFigure>
  validation: Partial<StoredValidation>
  media: ReadonlyArray<ApprovalMedia>
  job: PostJob | null
}

export interface PostApprovalView {
  id: string
  revision_id: string
  revision_number: number
  approved_by_email: string | null
  approved_at: string
  approval_hash: string
  figures_checked: boolean
  revoked_at: string | null
  revoked_reason: string | null
}

export interface PostDetail {
  id: string
  brand: Brand
  kind: PostKind
  title: string | null
  status: PostStatus
  source_url: string | null
  cancelled_at: string | null
  created_at: string
  updated_at: string
  revision: { id: string; number: number; created_at: string }
  /** The active approval of the current revision, if any. */
  approval: PostApprovalView | null
  destinations: PostDestinationView[]
  /** Jobs of earlier revisions that were not cancelled (sent, published, failed). */
  earlierJobs: PostJob[]
  approvals: PostApprovalView[]
  activity: Array<{ id: number; action: string; actor_email: string | null; created_at: string; details: Record<string, unknown> }>
}

export interface PostListDestination {
  destination_id: string
  account_id: string
  platform: Platform
  account_name: string
  scheduled_at: string | null
  job: Pick<PostJob, 'id' | 'status' | 'remote_url' | 'last_error_code' | 'last_error_message' | 'run_at' | 'published_at'> | null
}

export interface PostListItem {
  id: string
  brand: Brand | null
  kind: PostKind
  title: string | null
  status: PostStatus
  updated_at: string
  revision_number: number | null
  /** Earliest time among the current destinations. */
  first_at: string | null
  destinations: PostListDestination[]
  /** Sent or failed jobs of earlier revisions. */
  earlier: Array<PostListDestination & { revision_number: number }>
}

// ---------------------------------------------------------------------------
// Building blocks shared by the actions and the pages
// ---------------------------------------------------------------------------

interface DestinationRow {
  id: string
  revision_id: string
  account_id: string
  platform: Platform
  text: string
  settings: Record<string, unknown> | null
  scheduled_at: string | null
  contains_figures: boolean
  figures: DraftFigure[] | null
  validation: Partial<StoredValidation> | null
  account: ApprovalAccount | null
  media: Array<{
    media_id: string
    position: number
    alt_text: string
    file: { mime: string; width: number; height: number; sha256: string } | null
  }>
}

const DESTINATION_COLUMNS =
  'id, revision_id, account_id, platform, text, settings, scheduled_at, contains_figures, figures, validation, ' +
  'account:social_accounts(id, display_name, platform, mode, status, paused, daily_cap, rules), ' +
  'media:social_destination_media(media_id, position, alt_text, file:social_media(mime, width, height, sha256))'

function toApprovalDestination(d: DestinationRow): ApprovalDestination & { revision_id: string; contains_figures: boolean; validation: Partial<StoredValidation> } {
  if (!d.account) throw new Error(`destination ${d.id} has no account`)
  return {
    id: d.id,
    revision_id: d.revision_id,
    account_id: d.account_id,
    platform: d.platform,
    text: d.text,
    settings: d.settings ?? {},
    scheduled_at: d.scheduled_at,
    contains_figures: d.contains_figures,
    figures: d.figures ?? [],
    validation: d.validation ?? {},
    media: d.media
      .filter((m) => m.file)
      .sort((a, b) => a.position - b.position)
      .map((m) => ({
        media_id: m.media_id,
        position: m.position,
        alt_text: m.alt_text,
        sha256: m.file!.sha256,
        mime: m.file!.mime,
        width: m.file!.width,
        height: m.file!.height,
      })),
    account: { ...d.account, rules: d.account.rules ?? {} },
  }
}

/** Every destination of a revision, as stored, with its account and media. */
export async function loadRevisionDestinations(db: Db, revisionId: string) {
  const rows = must<DestinationRow[]>(
    await db.from('social_destinations').select(DESTINATION_COLUMNS).eq('revision_id', revisionId).order('platform'),
    'destinations'
  ) ?? []
  return rows.map(toApprovalDestination)
}

export interface PostRow {
  id: string
  brand_id: string
  kind: PostKind
  title: string | null
  status: PostStatus
  source_url: string | null
  cancelled_at: string | null
  current_revision_id: string | null
  created_at: string
  updated_at: string
}

export async function loadPost(db: Db, postId: string): Promise<PostRow | null> {
  return must<PostRow | null>(
    await db
      .from('social_posts')
      .select('id, brand_id, kind, title, status, source_url, cancelled_at, current_revision_id, created_at, updated_at')
      .eq('id', postId)
      .maybeSingle(),
    'post'
  )
}

/** The revision columns a copy must carry (a new revision only has what is passed). */
export async function loadRevisionCopy(db: Db, revisionId: string): Promise<Record<string, unknown>> {
  const r = must<Record<string, unknown> | null>(
    await db
      .from('social_post_revisions')
      .select('canonical_text, body_markdown, article, launch, card_spec, figures, variants, notes, generator_errors')
      .eq('id', revisionId)
      .maybeSingle(),
    'revision'
  )
  if (!r) throw new Error(`revision ${revisionId} not found`)
  return r
}

export async function hasActiveApproval(db: Db, revisionId: string): Promise<boolean> {
  const rows = must<Array<{ id: string }>>(
    await db.from('social_approvals').select('id').eq('revision_id', revisionId).is('revoked_at', null).limit(1),
    'approvals'
  ) ?? []
  return rows.length > 0
}

interface JobRow {
  id: string
  destination_id: string
  account_id: string
  status: JobStatus
  run_at: string
  attempts: number
  remote_url: string | null
  published_at: string | null
  last_error_code: string | null
  last_error_message: string | null
  manual_done_at: string | null
  cancelled_at: string | null
}

const JOB_COLUMNS =
  'id, destination_id, account_id, status, run_at, attempts, remote_url, published_at, last_error_code, last_error_message, manual_done_at, cancelled_at'

/** Jobs of these destinations. */
export async function jobsForDestinations(db: Db, destinationIds: readonly string[]): Promise<JobRow[]> {
  if (!destinationIds.length) return []
  return must<JobRow[]>(await db.from('social_delivery_jobs').select(JOB_COLUMNS).in('destination_id', destinationIds), 'jobs') ?? []
}

/**
 * What the cap and "suggest slot" count for these accounts from `from` on:
 * approved and scheduled, or published (PRD 5). Jobs of `excludeRevisionId`
 * are left out (they are cancelled when that revision is replaced).
 */
export async function bookedJobs(
  db: Db,
  accountIds: readonly string[],
  from: Date,
  opts: { to?: Date; excludeRevisionId?: string | null } = {}
): Promise<BookedJob[]> {
  if (!accountIds.length) return []
  let q = db
    .from('social_delivery_jobs')
    .select('id, account_id, run_at, destination_id')
    .in('account_id', accountIds)
    .in('status', CAP_COUNTED_STATUSES)
    .gte('run_at', from.toISOString())
  if (opts.to) q = q.lt('run_at', opts.to.toISOString())
  const rows = must<Array<{ id: string; account_id: string; run_at: string; destination_id: string }>>(await q, 'booked jobs') ?? []
  let excluded = new Set<string>()
  if (opts.excludeRevisionId) {
    const own = must<Array<{ id: string }>>(
      await db.from('social_destinations').select('id').eq('revision_id', opts.excludeRevisionId),
      'own destinations'
    ) ?? []
    excluded = new Set(own.map((d) => d.id))
  }
  return rows.filter((r) => !excluded.has(r.destination_id)).map((r) => ({ accountId: r.account_id, runAt: r.run_at }))
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export const POST_FILTERS = {
  active: { label: 'Active', statuses: ['approved', 'publishing', 'partial', 'failed'] },
  published: { label: 'Publicate', statuses: ['published'] },
  problems: { label: 'Cu probleme', statuses: ['failed', 'partial'] },
  drafts: { label: 'Neaprobate', statuses: ['draft'] },
  cancelled: { label: 'Anulate', statuses: ['cancelled'] },
  all: { label: 'Toate', statuses: ['draft', 'approved', 'publishing', 'published', 'partial', 'failed', 'cancelled'] },
} as const satisfies Record<string, { label: string; statuses: readonly PostStatus[] }>
export type PostFilter = keyof typeof POST_FILTERS

export function isPostFilter(v: unknown): v is PostFilter {
  return typeof v === 'string' && Object.hasOwn(POST_FILTERS, v)
}

export async function listPosts(filter: PostFilter = 'active', limit = 200): Promise<PostListItem[]> {
  const db = createAdminClient()
  const posts = must<Array<PostRow & { brand: Brand | null }>>(
    await db
      .from('social_posts')
      .select('id, brand_id, kind, title, status, source_url, cancelled_at, current_revision_id, created_at, updated_at, brand:social_brands(id, slug, name)')
      .in('status', POST_FILTERS[filter].statuses)
      .order('updated_at', { ascending: false })
      .limit(limit),
    'posts'
  ) ?? []
  if (!posts.length) return []

  const revisions = must<Array<{ id: string; post_id: string; number: number }>>(
    await db.from('social_post_revisions').select('id, post_id, number').in('post_id', posts.map((p) => p.id)),
    'revisions'
  ) ?? []
  const revById = new Map(revisions.map((r) => [r.id, r]))
  const dests = must<Array<{ id: string; revision_id: string; account_id: string; platform: Platform; scheduled_at: string | null; account: { display_name: string } | null }>>(
    await db
      .from('social_destinations')
      .select('id, revision_id, account_id, platform, scheduled_at, account:social_accounts(display_name)')
      .in('revision_id', revisions.map((r) => r.id))
      .order('platform'),
    'destinations'
  ) ?? []
  const jobs = await jobsForDestinations(db, dests.map((d) => d.id))
  const jobByDest = new Map(jobs.map((j) => [j.destination_id, j]))

  const view = (d: (typeof dests)[number]): PostListDestination => {
    const j = jobByDest.get(d.id)
    return {
      destination_id: d.id,
      account_id: d.account_id,
      platform: d.platform,
      account_name: d.account?.display_name ?? '-',
      scheduled_at: d.scheduled_at,
      job: j
        ? { id: j.id, status: j.status, remote_url: j.remote_url, last_error_code: j.last_error_code, last_error_message: j.last_error_message, run_at: j.run_at, published_at: j.published_at }
        : null,
    }
  }

  return posts.map((p) => {
    const mine = dests.filter((d) => revById.get(d.revision_id)?.post_id === p.id)
    const current = mine.filter((d) => d.revision_id === p.current_revision_id).map(view)
    const earlier = mine
      .filter((d) => d.revision_id !== p.current_revision_id)
      .map((d) => ({ ...view(d), revision_number: revById.get(d.revision_id)?.number ?? 0 }))
      .filter((d) => d.job && d.job.status !== 'cancelled')
    const times = current.map((d) => d.scheduled_at).filter(Boolean) as string[]
    return {
      id: p.id,
      brand: p.brand,
      kind: p.kind,
      title: p.title,
      status: p.status,
      updated_at: p.updated_at,
      revision_number: p.current_revision_id ? revById.get(p.current_revision_id)?.number ?? null : null,
      first_at: times.sort()[0] ?? null,
      destinations: current,
      earlier,
    }
  })
}

export async function getPost(postId: string): Promise<PostDetail | null> {
  const db = createAdminClient()
  const post = must<(PostRow & { brand: Brand }) | null>(
    await db
      .from('social_posts')
      .select('id, brand_id, kind, title, status, source_url, cancelled_at, current_revision_id, created_at, updated_at, brand:social_brands(id, slug, name)')
      .eq('id', postId)
      .maybeSingle(),
    'post'
  )
  if (!post || !post.current_revision_id) return null

  const [revisions, activity] = await Promise.all([
    db
      .from('social_post_revisions')
      .select('id, number, created_at')
      .eq('post_id', postId)
      .order('number', { ascending: false })
      .then((r) => must<Array<{ id: string; number: number; created_at: string }>>(r, 'revisions') ?? []),
    db
      .from('social_activity_log')
      .select('id, action, actor_email, created_at, details')
      .eq('post_id', postId)
      .order('created_at', { ascending: false })
      .limit(30)
      .then((r) => must<PostDetail['activity']>(r, 'activity') ?? []),
  ])
  const revNumber = new Map(revisions.map((r) => [r.id, r.number]))
  const current = revisions.find((r) => r.id === post.current_revision_id)
  if (!current) return null
  const revisionIds = revisions.map((r) => r.id)

  const [approvals, allDests] = await Promise.all([
    db
      .from('social_approvals')
      .select('id, revision_id, approved_by_email, approved_at, approval_hash, figures_checked, revoked_at, revoked_reason')
      .in('revision_id', revisionIds)
      .order('approved_at', { ascending: false })
      .then((r) => must<Array<Omit<PostApprovalView, 'revision_number'>>>(r, 'approvals') ?? []),
    db
      .from('social_destinations')
      .select(DESTINATION_COLUMNS)
      .in('revision_id', revisionIds)
      .order('platform')
      .then((r) => must<DestinationRow[]>(r, 'destinations') ?? []),
  ])
  const jobs = await jobsForDestinations(db, allDests.map((d) => d.id))
  const jobByDest = new Map(jobs.map((j) => [j.destination_id, j]))
  const destById = new Map(allDests.map((d) => [d.id, d]))
  const toJob = (j: JobRow): PostJob => {
    const d = destById.get(j.destination_id)!
    return {
      ...j,
      revision_id: d.revision_id,
      revision_number: revNumber.get(d.revision_id) ?? 0,
      platform: d.platform,
      account_name: d.account?.display_name ?? '-',
    }
  }

  const postApprovals = approvals.map((a) => ({ ...a, revision_number: revNumber.get(a.revision_id) ?? 0 }))

  return {
    id: post.id,
    brand: post.brand,
    kind: post.kind,
    title: post.title,
    status: post.status,
    source_url: post.source_url,
    cancelled_at: post.cancelled_at,
    created_at: post.created_at,
    updated_at: post.updated_at,
    revision: current,
    approval: postApprovals.find((a) => a.revision_id === current.id && !a.revoked_at) ?? null,
    destinations: allDests
      .filter((d) => d.revision_id === current.id)
      .map((d) => {
        const { revision_id: _rev, ...rest } = toApprovalDestination(d)
        const job = jobByDest.get(d.id)
        return { ...rest, job: job ? toJob(job) : null }
      }),
    earlierJobs: jobs
      .filter((j) => destById.get(j.destination_id)?.revision_id !== current.id && j.status !== 'cancelled')
      .map(toJob)
      .sort((a, b) => b.revision_number - a.revision_number || a.run_at.localeCompare(b.run_at)),
    approvals: postApprovals,
    activity,
  }
}
