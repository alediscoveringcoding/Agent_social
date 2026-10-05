/**
 * Approval (PRD F5, 8.2, 10.6) as pure functions, so the rules are tested
 * without a database. The server action (approval-actions.ts) loads the rows,
 * runs these, and hands the result to `social_approve_revision`, which repeats
 * what the database can check on its own (time on every destination, figures
 * checked, no unverified figure, daily cap) and writes approval + jobs in one
 * transaction.
 *
 *  - Every hard check of 8.2 runs again here, with the chosen time, against the
 *    rows as stored (not what the browser sent). Any error blocks.
 *  - "Figures checked" is needed when any destination contains a figure, or
 *    lists one (the card carries the draft's figures).
 *  - Hashes are computed over the stored rows: destination_hash over
 *    {account_id, platform, text, settings, scheduled_at, media[sha256, alt]},
 *    approval_hash over {post_id, revision_id, destination hashes by id}.
 *    The worker recomputes destination_hash from the delivery payload.
 *
 * Server-side (hash.ts uses node:crypto).
 */

import { SOCIAL_TIMEZONE, type Platform, type PostKind } from './constants.ts'
import { toStoredValidation, type StoredValidation } from './draft-mapping.ts'
import type { DraftFigure } from './figures.ts'
import { approvalHash, destinationHash, toHashTimestamp } from './hash.ts'
import { checkDailyCap, bucharestDay, zonedLocalToUtc, type CapItem, type CapViolation } from './time.ts'
import { validateDestination, type DestinationValidation, type ValidationIssue } from './validation.ts'

export interface ApprovalMedia {
  media_id: string
  position: number
  alt_text: string
  sha256: string
  mime: string
  width: number
  height: number
}

export interface ApprovalAccount {
  id: string
  display_name: string
  platform: Platform
  mode: 'auto' | 'manual'
  status: string
  paused: boolean
  daily_cap: number
  rules: Record<string, unknown> | null
}

/** A destination of the revision to approve, as stored. */
export interface ApprovalDestination {
  id: string
  account_id: string
  platform: Platform
  text: string
  settings: Record<string, unknown>
  scheduled_at: string | null
  figures: ReadonlyArray<DraftFigure>
  media: ReadonlyArray<ApprovalMedia>
  account: ApprovalAccount
}

export interface LocalTime {
  /** "YYYY-MM-DD" in Bucharest. */
  date: string
  /** "HH:mm" in Bucharest. */
  time: string
}

export interface DestinationIssues {
  accountId: string
  platform: Platform
  account: string
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

export interface CheckedDestination {
  row: ApprovalDestination
  validation: DestinationValidation
  /** Text figures, or figures listed on the destination. */
  containsFigures: boolean
}

export class ApprovalInputError extends Error {}

/** A Bucharest date + time from the form to the instant (whole seconds). */
export function localToInstant(value: LocalTime | null | undefined): Date | null {
  if (!value || !value.date || !value.time) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date) || !/^\d{2}:\d{2}$/.test(value.time)) {
    throw new ApprovalInputError('Data sau ora nu e valida.')
  }
  // W1: reject calendar overflow before the DST-aware conversion.
  const [year, month, day] = value.date.split('-').map(Number)
  const calendar = new Date(`${value.date}T00:00:00Z`)
  if (!Number.isFinite(calendar.getTime()) || calendar.getUTCFullYear() !== year ||
      calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) {
    throw new ApprovalInputError('Data sau ora nu e valida.')
  }
  try {
    return zonedLocalToUtc(value.date, value.time, SOCIAL_TIMEZONE)
  } catch {
    throw new ApprovalInputError('Data sau ora nu e valida.')
  }
}

/** Same instant to the second (how hashes and the database compare times). */
export function sameInstant(a: string | Date | null | undefined, b: string | Date | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return toHashTimestamp(a) === toHashTimestamp(b)
}

/** Run the hard checks of 8.2 on every destination, with its time. */
export function checkDestinations(
  rows: ReadonlyArray<ApprovalDestination>,
  opts: { kind: PostKind; now: Date; legalNames?: ReadonlyArray<string> }
): CheckedDestination[] {
  return rows.map((row) => {
    const media = [...row.media].sort((a, b) => a.position - b.position)
    const validation = validateDestination({
      platform: row.platform,
      kind: opts.kind,
      text: row.text,
      settings: row.settings ?? {},
      media: media.map((m) => ({ mediaId: m.media_id, mime: m.mime, width: m.width, height: m.height, altText: m.alt_text })),
      figures: row.figures ?? [],
      scheduledAt: row.scheduled_at,
      now: opts.now,
      rules: row.account.rules ?? null,
      legalNames: opts.legalNames ?? [],
    })
    return { row, validation, containsFigures: validation.containsFigures || (row.figures ?? []).length > 0 }
  })
}

export function issuesOf(checked: ReadonlyArray<CheckedDestination>): DestinationIssues[] {
  return checked
    .filter((c) => c.validation.errors.length || c.validation.warnings.length)
    .map((c) => ({
      accountId: c.row.account_id,
      platform: c.row.platform,
      account: c.row.account.display_name,
      errors: c.validation.errors,
      warnings: c.validation.warnings,
    }))
}

/** Daily cap (PRD 5) before writing anything; the database checks again under a lock. */
export function capViolations(
  rows: ReadonlyArray<ApprovalDestination>,
  existing: ReadonlyArray<CapItem>
): Array<CapViolation & { account: string }> {
  const adding = rows.filter((r) => r.scheduled_at).map((r) => ({ accountId: r.account_id, scheduledAt: r.scheduled_at! }))
  const caps = Object.fromEntries(rows.map((r) => [r.account_id, r.account.daily_cap]))
  const names = new Map(rows.map((r) => [r.account_id, r.account.display_name]))
  return checkDailyCap(existing, adding, caps).map((v) => ({ ...v, account: names.get(v.accountId) ?? v.accountId }))
}

export function capMessage(v: { account: string; day: string; used: number; adding?: number; cap: number }): string {
  const [y, m, d] = v.day.split('-')
  return `Limita zilnica: contul ${v.account} are deja ${v.used} ${v.used === 1 ? 'postare' : 'postari'} pe ${d}.${m}.${y} (maximum ${v.cap} pe zi, ora Bucurestiului). Alege alta zi.`
}

/** Bucharest days this approval touches, for the cap query. */
export function daysOf(rows: ReadonlyArray<{ scheduled_at: string | null }>): string[] {
  return [...new Set(rows.filter((r) => r.scheduled_at).map((r) => bucharestDay(r.scheduled_at!)))].sort()
}

export interface ApprovalPayload {
  approvalHash: string
  destinations: Array<{ id: string; destination_hash: string; validation: StoredValidation; contains_figures: boolean }>
}

/** Hashes (PRD 10.6) and the derived columns the approval writes. */
export function buildApproval(
  postId: string,
  revisionId: string,
  checked: ReadonlyArray<CheckedDestination>,
  now: Date
): ApprovalPayload {
  const destinations = checked.map((c) => {
    if (!c.row.scheduled_at) throw new ApprovalInputError('Fiecare destinatie are nevoie de data si ora.')
    const media = [...c.row.media].sort((a, b) => a.position - b.position)
    return {
      id: c.row.id,
      destination_hash: destinationHash({
        account_id: c.row.account_id,
        platform: c.row.platform,
        text: c.row.text,
        settings: c.row.settings ?? {},
        scheduled_at: c.row.scheduled_at,
        media: media.map((m) => ({ sha256: m.sha256, alt_text: m.alt_text })),
      }),
      validation: toStoredValidation(c.validation, now),
      contains_figures: c.containsFigures,
    }
  })
  return {
    approvalHash: approvalHash({ post_id: postId, revision_id: revisionId, destinations }),
    destinations,
  }
}
