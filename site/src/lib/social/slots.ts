/**
 * "Suggest slot" (PRD F4, Should; amendment 03): the next free time per
 * account under its daily cap, on the default slots 09:00, 13:00 and 18:00
 * Europe/Bucharest (editable per request).
 *
 * A slot is free for an account when
 *  - it is at least `leadMinutes` in the future,
 *  - the account's Bucharest day still has room under its cap, counting what
 *    is already booked (approved and scheduled, or published) plus what this
 *    suggestion has handed out, and
 *  - nothing booked for the account sits within `gapMinutes` of it.
 *
 * Pure and browser-safe (Intl only, through time.ts). Days are Bucharest
 * calendar days, so the 23- and 25-hour DST days count like any other.
 */

import { MAX_DAILY_CAP } from './constants.ts'
import { bucharestDay, toLocalInputs, zonedLocalToUtc } from './time.ts'

export const DEFAULT_SLOTS = ['09:00', '13:00', '18:00'] as const

export interface SlotAccount {
  id: string
  /** The account's daily cap (1..5). */
  cap: number
}

export interface BookedJob {
  accountId: string
  /** ISO instant. */
  runAt: string
}

export interface SuggestOptions {
  now?: Date
  /** "HH:mm" wall-clock times in Bucharest; defaults to DEFAULT_SLOTS. */
  slots?: ReadonlyArray<string>
  /** A slot must be at least this far ahead. Default 15. */
  leadMinutes?: number
  /** Minimum distance to anything already booked on the account. Default 60. */
  gapMinutes?: number
  /** How many days ahead to look. Default 60. */
  horizonDays?: number
}

export interface Suggestion {
  accountId: string
  /** ISO instant, or null when nothing is free inside the horizon. */
  at: string | null
  /** For the date and time inputs (Bucharest). */
  date: string | null
  time: string | null
}

const SLOT = /^([01]\d|2[0-3]):[0-5]\d$/

/** "09:00, 13:00,18:00" -> sorted, unique, valid "HH:mm" values. Invalid entries are dropped. */
export function parseSlots(value: string | ReadonlyArray<string> | null | undefined): string[] {
  const parts = typeof value === 'string' ? value.split(/[,\s;]+/) : [...(value ?? [])]
  const out = new Set<string>()
  for (const raw of parts) {
    const p = raw.trim()
    const m = /^(\d{1,2}):(\d{2})$/.exec(p)
    if (!m) continue
    const hhmm = `${m[1].padStart(2, '0')}:${m[2]}`
    if (SLOT.test(hhmm)) out.add(hhmm)
  }
  return [...out].sort()
}

function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + 1))
  return next.toISOString().slice(0, 10)
}

/**
 * One suggestion per account, in the order given. Accounts are independent:
 * the same post usually goes out at the same time everywhere.
 */
export function suggestSlots(
  accounts: ReadonlyArray<SlotAccount>,
  booked: ReadonlyArray<BookedJob>,
  opts: SuggestOptions = {}
): Suggestion[] {
  const now = opts.now ?? new Date()
  const slots = parseSlots(opts.slots && opts.slots.length ? opts.slots : DEFAULT_SLOTS)
  const lead = (opts.leadMinutes ?? 15) * 60_000
  const gap = (opts.gapMinutes ?? 60) * 60_000
  const horizon = opts.horizonDays ?? 60

  const taken = new Map<string, number[]>()
  for (const b of booked) {
    const t = new Date(b.runAt).getTime()
    if (!Number.isFinite(t)) continue
    const list = taken.get(b.accountId) ?? []
    list.push(t)
    taken.set(b.accountId, list)
  }

  return accounts.map((acc) => {
    const cap = Math.max(0, Math.min(acc.cap || MAX_DAILY_CAP, MAX_DAILY_CAP))
    const mine = taken.get(acc.id) ?? []
    let day = bucharestDay(now)
    for (let i = 0; i <= horizon && slots.length && cap > 0; i++, day = nextDay(day)) {
      const used = mine.filter((t) => bucharestDay(t) === day).length
      if (used >= cap) continue
      for (const slot of slots) {
        const at = zonedLocalToUtc(day, slot)
        const t = at.getTime()
        // A slot in a DST gap moves forward; it must still be on this day.
        if (bucharestDay(at) !== day) continue
        if (t < now.getTime() + lead) continue
        if (mine.some((x) => Math.abs(x - t) < gap)) continue
        mine.push(t)
        taken.set(acc.id, mine)
        const local = toLocalInputs(at)
        return { accountId: acc.id, at: at.toISOString(), date: local.date, time: local.time }
      }
    }
    return { accountId: acc.id, at: null, date: null, time: null }
  })
}
