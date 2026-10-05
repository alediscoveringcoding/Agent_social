'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin, type AdminIdentity } from '@/lib/auth/admin'
import { AdminAuthError } from '@/lib/auth/decision'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  ApprovalInputError,
  buildApproval,
  capMessage,
  capViolations,
  checkDestinations,
  daysOf,
  issuesOf,
  localToInstant,
  sameInstant,
  type ApprovalDestination,
  type DestinationIssues,
  type LocalTime,
} from './approval.ts'
import {
  CANCELLABLE_STATUSES,
  bookedJobs,
  hasActiveApproval,
  jobsForDestinations,
  loadPost,
  loadRevisionCopy,
  loadRevisionDestinations,
  type PostRow,
} from './approval-queries.ts'
import { legalNamesFromEnv } from './content-rules.ts'
import type { StoredValidation } from './draft-mapping.ts'
import { logActivity } from './server/activity.ts'
import { parseSlots, suggestSlots } from './slots.ts'
import { bucharestDay, dayBoundsUtc, formatBucharest } from './time.ts'

/**
 * Server actions for approval and scheduling (PRD F4 "suggest slot", F5;
 * amendment 03, W1). Each one is a public endpoint: requireAdmin() first
 * (allowlisted email + aal2 session), every time. State changes go through
 * the SQL functions, one transaction each:
 *
 *   approve        social_approve_revision (approval row + one job per
 *                  destination; checks time, figures, cap under a lock)
 *   new times      social_save_revision (a new revision; an approved one is
 *                  revoked and its unsubmitted jobs cancelled in the same go)
 *   cancel         social_cancel (one destination, or the whole post)
 *   retry failed   social_retry_failed
 *
 * The content rules (PRD 8.2) run here again with the chosen times before
 * anything is written; every action leaves a row in social_activity_log.
 */

export type ApprovalResult<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; issues?: DestinationIssues[] }

type Db = ReturnType<typeof createAdminClient>

const SQL_ERRORS: Record<string, string> = {
  SOCIAL_STALE_REVISION: 'Postarea a fost modificata intre timp. Reincarca pagina.',
  SOCIAL_POST_CANCELLED: 'Postarea a fost anulata.',
  SOCIAL_POST_NOT_FOUND: 'Postarea nu mai exista.',
  SOCIAL_ALREADY_APPROVED: 'Revizia e deja aprobata.',
  SOCIAL_NO_DESTINATIONS: 'Postarea nu are nicio destinatie. Alege platformele in editor.',
  SOCIAL_HASHES_INCOMPLETE: 'Postarea s-a schimbat in timpul aprobarii. Reincarca pagina.',
  SOCIAL_MISSING_TIME: 'Fiecare destinatie are nevoie de data si ora.',
  SOCIAL_FIGURES_NOT_CHECKED: 'Postarea contine cifre. Bifeaza "Am verificat cifrele" dupa ce le-ai verificat.',
  SOCIAL_UNVERIFIED_FIGURE: 'O cifra neverificata blocheaza aprobarea. Confirm-o sau scoate-o din editor.',
  SOCIAL_NOT_APPROVED: 'Postarea nu e aprobata.',
  SOCIAL_JOB_NOT_FOUND: 'Destinatia nu mai exista.',
  SOCIAL_NOT_CANCELLABLE: 'Destinatia a plecat deja spre platforma si nu mai poate fi anulata.',
  SOCIAL_DESTINATION_IN_FLIGHT: 'O destinatie tocmai a plecat spre platforma. Reincarca pagina si incearca din nou.',
  SOCIAL_ACCOUNT_OTHER_BRAND: 'Unul dintre conturi nu apartine brandului postarii.',
  SOCIAL_ACCOUNT_NOT_FOUND: 'Unul dintre conturi nu mai exista.',
  SOCIAL_REVISION_FROZEN: 'O revizie aprobata nu se mai schimba; se face o revizie noua.',
}

const STALE = SQL_ERRORS.SOCIAL_STALE_REVISION

/** An error returned by an rpc, with PostgREST's `details` kept (the cap names account and day there). */
class SqlError extends Error {
  readonly details: string | null
  constructor(error: { message: string; details?: string | null }) {
    super(error.message)
    this.details = error.details ?? null
  }
}

function friendlyError(e: unknown): string | null {
  const message = e instanceof Error ? e.message : String(e)
  if (message.includes('SOCIAL_DAILY_CAP')) {
    try {
      const d = JSON.parse((e as SqlError).details ?? '') as { account: string; day: string; used: number; cap: number }
      return capMessage(d)
    } catch {
      return 'Limita zilnica a contului e atinsa in ziua aleasa. Alege alta zi.'
    }
  }
  for (const [code, text] of Object.entries(SQL_ERRORS)) if (message.includes(code)) return text
  return null
}

async function rpc<T>(db: Db, fn: string, params: Record<string, unknown>): Promise<T> {
  const { data, error } = await db.rpc(fn, params)
  if (error) throw new SqlError(error)
  return data as T
}

async function guarded<T extends object>(
  label: string,
  body: (admin: AdminIdentity) => Promise<ApprovalResult<T>>
): Promise<ApprovalResult<T>> {
  try {
    return await body(await requireAdmin())
  } catch (e) {
    if (e instanceof AdminAuthError || e instanceof ApprovalInputError) return { ok: false, error: e.message }
    const friendly = friendlyError(e)
    if (friendly) return { ok: false, error: friendly }
    console.error(`[social/approval] ${label} failed:`, e)
    return { ok: false, error: 'Ceva nu a mers. Incearca din nou; daca se repeta, verifica jurnalul serverului.' }
  }
}

function revalidatePost(postId: string) {
  revalidatePath('/admin/social')
  revalidatePath('/admin/social/postari')
  revalidatePath(`/admin/social/postari/${postId}`)
  revalidatePath('/admin/social/ciorne')
  revalidatePath(`/admin/social/ciorne/${postId}`)
  revalidatePath('/admin/social/calendar')
}

const fail = (error: string, issues?: DestinationIssues[]): { ok: false; error: string; issues?: DestinationIssues[] } =>
  issues ? { ok: false, error, issues } : { ok: false, error }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function requireId(value: unknown, what = 'Postarea'): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ApprovalInputError(`${what} nu exista.`)
  return value
}

async function openPost(db: Db, postId: string, revisionId?: string): Promise<PostRow & { current_revision_id: string }> {
  const post = await loadPost(db, requireId(postId))
  if (!post || !post.current_revision_id) throw new ApprovalInputError('Postarea nu mai exista.')
  if (post.cancelled_at) throw new ApprovalInputError('Postarea a fost anulata.')
  if (revisionId !== undefined && post.current_revision_id !== revisionId) throw new ApprovalInputError(STALE)
  return post as PostRow & { current_revision_id: string }
}

/** The times the form asks for, by account; a destination without one keeps its stored time. */
function wantedTimes(rows: ReadonlyArray<ApprovalDestination>, times: Record<string, LocalTime> | undefined): Map<string, string | null> {
  const out = new Map<string, string | null>()
  for (const r of rows) {
    const asked = times?.[r.account_id]
    const at = asked ? localToInstant(asked) : r.scheduled_at ? new Date(r.scheduled_at) : null
    out.set(r.account_id, at ? at.toISOString() : null)
  }
  return out
}

/** Cap check before writing: what is booked on those Bucharest days, minus this post's current jobs. */
async function capError(db: Db, post: PostRow & { current_revision_id: string }, planned: ReadonlyArray<ApprovalDestination>): Promise<string | null> {
  const days = daysOf(planned)
  if (!days.length) return null
  const from = dayBoundsUtc(days[0]).start
  const to = dayBoundsUtc(days[days.length - 1]).end
  const booked = await bookedJobs(db, [...new Set(planned.map((p) => p.account_id))], from, {
    to,
    excludeRevisionId: post.current_revision_id,
  })
  const over = capViolations(planned, booked.map((b) => ({ accountId: b.accountId, scheduledAt: b.runAt })))
  return over.length ? capMessage(over[0]) : null
}

/**
 * A new revision with the same content and the given times (destinations are
 * insert-only, so a new time is a new revision). `keep` lists the accounts
 * carried over; the rest stay with the old revision.
 */
async function saveTimesRevision(
  db: Db,
  actor: AdminIdentity,
  post: PostRow & { current_revision_id: string },
  rows: ReadonlyArray<ApprovalDestination & { contains_figures?: boolean; validation?: Partial<StoredValidation> }>,
  times: Map<string, string | null>,
  reason: string
): Promise<string> {
  const revision = await loadRevisionCopy(db, post.current_revision_id)
  const destinations = rows
    .filter((r) => times.has(r.account_id))
    .map((r) => ({
      account_id: r.account_id,
      text: r.text,
      settings: r.settings,
      scheduled_at: times.get(r.account_id) ?? null,
      figures: r.figures,
      contains_figures: r.contains_figures ?? false,
      validation: r.validation ?? {},
      media: r.media.map((m) => ({ media_id: m.media_id, position: m.position, alt_text: m.alt_text })),
    }))
  return rpc<string>(db, 'social_save_revision', {
    p_post: post.id,
    p_base_revision: post.current_revision_id,
    p_actor: actor.userId,
    p_revision: { ...revision, title: post.title },
    p_destinations: destinations,
    p_reason: reason,
  })
}

// ---------------------------------------------------------------------------
// Approve (F5)
// ---------------------------------------------------------------------------

export interface ApproveInput {
  postId: string
  /** The revision the admin looked at; a newer one means someone saved in between. */
  revisionId: string
  /** Bucharest date + time per account id. */
  times?: Record<string, LocalTime>
  /** "Am verificat cifrele". */
  figuresChecked: boolean
}

export async function approvePost(
  input: ApproveInput
): Promise<ApprovalResult<{ revisionId: string; approvalId: string; jobs: number }>> {
  return guarded<{ revisionId: string; approvalId: string; jobs: number }>('approvePost', async (actor) => {
    const db = createAdminClient()
    const now = new Date()
    const legalNames = legalNamesFromEnv(process.env.SOCIAL_LEGAL_NAMES)
    const post = await openPost(db, input.postId, input.revisionId)
    if (await hasActiveApproval(db, post.current_revision_id)) {
      return fail('Revizia e deja aprobata. Pentru alta ora foloseste "Reprogrameaza".')
    }

    let rows = await loadRevisionDestinations(db, post.current_revision_id)
    if (!rows.length) return fail(SQL_ERRORS.SOCIAL_NO_DESTINATIONS)
    const times = wantedTimes(rows, input.times)
    const planned = rows.map((r) => ({ ...r, scheduled_at: times.get(r.account_id) ?? null }))

    // 1. Every hard check, with the chosen times, before anything is written.
    const checked = checkDestinations(planned, { kind: post.kind, now, legalNames })
    const issues = issuesOf(checked)
    const errors = checked.reduce((n, c) => n + c.validation.errors.length, 0)
    if (errors) {
      return fail(`${errors} ${errors === 1 ? 'problema blocheaza' : 'probleme blocheaza'} aprobarea.`, issues)
    }
    if (checked.some((c) => c.containsFigures) && !input.figuresChecked) {
      return fail(SQL_ERRORS.SOCIAL_FIGURES_NOT_CHECKED)
    }

    // 2. Daily cap per Bucharest day (the database checks again, under a lock).
    const cap = await capError(db, post, planned)
    if (cap) return fail(cap)

    // 3. New times make a new revision first; then hash exactly what is stored.
    let revisionId = post.current_revision_id
    if (planned.some((p, i) => !sameInstant(p.scheduled_at, rows[i].scheduled_at))) {
      revisionId = await saveTimesRevision(db, actor, post, rows, times, 'schedule')
      rows = await loadRevisionDestinations(db, revisionId)
    }
    const final = checkDestinations(rows, { kind: post.kind, now, legalNames })
    if (final.some((c) => c.validation.errors.length)) {
      return fail('Postarea s-a schimbat in timpul aprobarii. Reincarca pagina.', issuesOf(final))
    }
    const payload = buildApproval(post.id, revisionId, final, now)

    // 4. Approval row and one job per destination, in one transaction.
    const approvalId = await rpc<string>(db, 'social_approve_revision', {
      p_post: post.id,
      p_revision: revisionId,
      p_actor: actor.userId,
      p_actor_email: actor.email,
      p_approval_hash: payload.approvalHash,
      p_figures_checked: Boolean(input.figuresChecked),
      p_destinations: payload.destinations,
    })

    await logActivity(db, actor, {
      action: 'social.approved',
      postId: post.id,
      details: {
        revision_id: revisionId,
        approval_id: approvalId,
        approval_hash: payload.approvalHash,
        figures_checked: Boolean(input.figuresChecked),
        destinations: rows.map((r) => ({ account_id: r.account_id, platform: r.platform, scheduled_at: r.scheduled_at })),
        warnings: issues.reduce((n, i) => n + i.warnings.length, 0),
      },
    })
    revalidatePost(post.id)
    return { ok: true, revisionId, approvalId, jobs: rows.length }
  })
}

// ---------------------------------------------------------------------------
// Times: save for a draft, reschedule an approved post (F5)
// ---------------------------------------------------------------------------

/** A destination whose job is in one of these can get a new time in a new revision. */
const MOVABLE = new Set<string>(['queued', 'claimed', 'manual_pending', 'failed'])

export interface RescheduleInput {
  postId: string
  revisionId: string
  /** Bucharest date + time per account id; an account left out keeps its time. */
  times?: Record<string, LocalTime>
}

/**
 * Save new times as a new revision. On an approved post this is the
 * reschedule of PRD F5: the approval is revoked and the old revision's
 * unsubmitted jobs are cancelled in the same transaction, and the post needs
 * a new approval. Destinations that already left (or were cancelled) stay
 * with their revision.
 */
export async function reschedulePost(
  input: RescheduleInput
): Promise<ApprovalResult<{ revisionId: string; changed: boolean; carried: number; left: number }>> {
  return guarded<{ revisionId: string; changed: boolean; carried: number; left: number }>('reschedulePost', async (actor) => {
    const db = createAdminClient()
    const now = new Date()
    const post = await openPost(db, input.postId, input.revisionId)
    const approved = await hasActiveApproval(db, post.current_revision_id)
    const rows = await loadRevisionDestinations(db, post.current_revision_id)
    const jobs = await jobsForDestinations(db, rows.map((r) => r.id))
    const jobByDest = new Map(jobs.map((j) => [j.destination_id, j]))
    const movable = rows.filter((r) => {
      const j = jobByDest.get(r.id)
      return !j || MOVABLE.has(j.status)
    })
    if (!movable.length) return fail('Nu mai e nimic de reprogramat: destinatiile au plecat deja sau au fost anulate.')

    const times = wantedTimes(movable, input.times)
    for (const r of movable) {
      const at = times.get(r.account_id)
      if (at && new Date(at).getTime() < now.getTime() - 60_000) {
        return fail(`Ora pentru ${r.account.display_name} (${formatBucharest(at)}) a trecut deja.`)
      }
    }
    const planned = movable.map((r) => ({ ...r, scheduled_at: times.get(r.account_id) ?? null }))
    const cap = await capError(db, post, planned)
    if (cap) return fail(cap)

    const changed = planned.some((p, i) => !sameInstant(p.scheduled_at, movable[i].scheduled_at))
    if (!changed && !approved && movable.length === rows.length) {
      return { ok: true, revisionId: post.current_revision_id, changed: false, carried: movable.length, left: 0 }
    }
    if (!changed && approved) return fail('Nicio ora nu s-a schimbat.')

    const cancelled = jobs.filter((j) => (CANCELLABLE_STATUSES as readonly string[]).includes(j.status)).length
    const revisionId = await saveTimesRevision(db, actor, post, movable, times, approved ? 'reschedule' : 'schedule')
    await logActivity(db, actor, {
      action: approved ? 'social.rescheduled' : 'social.schedule_saved',
      postId: post.id,
      details: {
        revision_id: revisionId,
        base_revision_id: post.current_revision_id,
        approval_revoked: approved,
        jobs_cancelled: approved ? cancelled : 0,
        destinations: planned.map((p) => ({ account_id: p.account_id, scheduled_at: p.scheduled_at })),
        left_behind: rows.length - movable.length,
      },
    })
    revalidatePost(post.id)
    return { ok: true, revisionId, changed: true, carried: movable.length, left: rows.length - movable.length }
  })
}

/**
 * "Edit after approval": a new revision with the same content and times, so
 * the draft editor can change it. The approval is revoked and unsubmitted
 * jobs are cancelled in the same transaction (F5). A draft needs nothing.
 */
export async function reopenForEdit(input: { postId: string; revisionId: string }): Promise<ApprovalResult<{ revisionId: string; reopened: boolean }>> {
  return guarded<{ revisionId: string; reopened: boolean }>('reopenForEdit', async (actor) => {
    const db = createAdminClient()
    const post = await openPost(db, input.postId, input.revisionId)
    if (!(await hasActiveApproval(db, post.current_revision_id))) {
      return { ok: true, revisionId: post.current_revision_id, reopened: false }
    }
    const rows = await loadRevisionDestinations(db, post.current_revision_id)
    const jobs = await jobsForDestinations(db, rows.map((r) => r.id))
    const jobByDest = new Map(jobs.map((j) => [j.destination_id, j]))
    const movable = rows.filter((r) => {
      const j = jobByDest.get(r.id)
      return !j || MOVABLE.has(j.status)
    })
    if (!movable.length) return fail('Nu mai e nimic de editat: destinatiile au plecat deja sau au fost anulate.')
    const times = new Map(movable.map((r) => [r.account_id, r.scheduled_at]))
    const cancelled = jobs.filter((j) => (CANCELLABLE_STATUSES as readonly string[]).includes(j.status)).length
    const revisionId = await saveTimesRevision(db, actor, post, movable, times, 'edit')
    await logActivity(db, actor, {
      action: 'social.reopened_for_edit',
      postId: post.id,
      details: { revision_id: revisionId, base_revision_id: post.current_revision_id, jobs_cancelled: cancelled, left_behind: rows.length - movable.length },
    })
    revalidatePost(post.id)
    return { ok: true, revisionId, reopened: true }
  })
}

// ---------------------------------------------------------------------------
// Suggest slot (F4, Should)
// ---------------------------------------------------------------------------

export async function suggestTimes(input: {
  postId: string
  /** "09:00, 13:00, 18:00" or a list; empty = the defaults. */
  slots?: string | string[]
}): Promise<ApprovalResult<{ suggestions: Record<string, LocalTime | null>; slots: string[] }>> {
  return guarded<{ suggestions: Record<string, LocalTime | null>; slots: string[] }>('suggestTimes', async () => {
    const db = createAdminClient()
    const post = await openPost(db, input.postId)
    const rows = await loadRevisionDestinations(db, post.current_revision_id)
    const slots = parseSlots(input.slots ?? [])
    if (input.slots && (typeof input.slots === 'string' ? input.slots.trim() : input.slots.length) && !slots.length) {
      return fail('Orele implicite se scriu HH:mm, separate prin virgula (ex. 09:00, 13:00, 18:00).')
    }
    const now = new Date()
    // W1: midnight slots also need the gap from late bookings on the previous day.
    const from = new Date(dayBoundsUtc(bucharestDay(now)).start.getTime() - 60 * 60_000)
    const booked = await bookedJobs(db, rows.map((r) => r.account_id), from, {
      excludeRevisionId: post.current_revision_id,
    })
    const out = suggestSlots(
      rows.map((r) => ({ id: r.account_id, cap: r.account.daily_cap })),
      booked,
      { now, slots: slots.length ? slots : undefined }
    )
    return {
      ok: true,
      slots: slots.length ? slots : ['09:00', '13:00', '18:00'],
      suggestions: Object.fromEntries(out.map((s) => [s.accountId, s.date && s.time ? { date: s.date, time: s.time } : null])),
    }
  })
}

// ---------------------------------------------------------------------------
// Cancel, retry (F5)
// ---------------------------------------------------------------------------

export async function cancelDestination(input: { postId: string; jobId: string }): Promise<ApprovalResult> {
  return guarded('cancelDestination', async (actor) => {
    const db = createAdminClient()
    const postId = requireId(input.postId)
    const jobId = requireId(input.jobId, 'Destinatia')
    await rpc(db, 'social_cancel', { p_post: postId, p_job: jobId, p_actor: actor.userId })
    await logActivity(db, actor, { action: 'social.destination_cancelled', postId, jobId })
    revalidatePost(postId)
    return { ok: true }
  })
}

export async function cancelPost(input: { postId: string }): Promise<ApprovalResult<{ cancelled: number }>> {
  return guarded<{ cancelled: number }>('cancelPost', async (actor) => {
    const db = createAdminClient()
    const postId = requireId(input.postId)
    const post = await loadPost(db, postId)
    if (!post) return fail('Postarea nu mai exista.')
    if (post.cancelled_at) return fail('Postarea e deja anulata.')
    const r = await rpc<{ cancelled: number }>(db, 'social_cancel', { p_post: postId, p_job: null, p_actor: actor.userId })
    await logActivity(db, actor, { action: 'social.post_cancelled', postId, details: { title: post.title, jobs_cancelled: r?.cancelled ?? 0 } })
    revalidatePost(postId)
    return { ok: true, cancelled: r?.cancelled ?? 0 }
  })
}

const SKIP_REASONS: Record<string, string> = {
  STALE_WINDOW: 'a trecut de fereastra de 2 ore; reprogrameaz-o',
  NEEDS_CONFIRMATION: 'confirma intai ca postarea nu a ajuns pe platforma',
  DAILY_CAP: 'limita zilnica a contului e atinsa',
}

export async function retryFailed(input: {
  postId: string
  /** For RECONCILE_MISS: a person checked that the post is not on the platform. */
  confirmReconcileMiss?: boolean
}): Promise<ApprovalResult<{ retried: number; skipped: Array<{ job_id: string; reason: string; message: string }> }>> {
  return guarded<{ retried: number; skipped: Array<{ job_id: string; reason: string; message: string }> }>('retryFailed', async (actor) => {
    const db = createAdminClient()
    const postId = requireId(input.postId)
    // W1: a cancelled post cannot restart failed deliveries.
    await openPost(db, postId)
    const r = await rpc<{ retried: number; skipped: Array<{ job_id: string; reason: string }> }>(db, 'social_retry_failed', {
      p_post: postId,
      p_actor: actor.userId,
      p_confirm_reconcile_miss: Boolean(input.confirmReconcileMiss),
    })
    await logActivity(db, actor, {
      action: 'social.retry_failed',
      postId,
      details: { retried: r.retried, skipped: r.skipped, confirm_reconcile_miss: Boolean(input.confirmReconcileMiss) },
    })
    revalidatePost(postId)
    return {
      ok: true,
      retried: r.retried,
      skipped: (r.skipped ?? []).map((s) => ({ ...s, message: SKIP_REASONS[s.reason] ?? s.reason })),
    }
  })
}
