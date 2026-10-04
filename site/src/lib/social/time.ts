/**
 * Times for social publishing: stored in UTC, shown and counted in
 * Europe/Bucharest (PRD D12). The daily cap counts per Bucharest CALENDAR day,
 * which is 23 hours long on the last Sunday of March and 25 hours on the last
 * Sunday of October.
 *
 * Pure and browser-safe (Intl only). The database does the same arithmetic
 * with `AT TIME ZONE 'Europe/Bucharest'`; the tests hold the two to the same
 * answers across both DST changes.
 */

import { MAX_DAILY_CAP, SOCIAL_TIMEZONE } from './constants.ts'

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(tz, f)
  }
  return f
}

function toDate(instant: Date | string | number): Date {
  const d = instant instanceof Date ? instant : new Date(instant)
  if (!Number.isFinite(d.getTime())) throw new Error(`not a valid instant: ${String(instant)}`)
  return d
}

export function localParts(instant: Date | string | number, tz = SOCIAL_TIMEZONE): LocalParts {
  const out: Record<string, number> = {}
  for (const p of partsFormatter(tz).formatToParts(toDate(instant))) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  }
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** "YYYY-MM-DD" of the instant in Bucharest. */
export function bucharestDay(instant: Date | string | number, tz = SOCIAL_TIMEZONE): string {
  const p = localParts(instant, tz)
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`
}

/** Minutes the zone is ahead of UTC at that instant (+120 in winter, +180 in summer). */
export function offsetMinutes(instant: Date | string | number, tz = SOCIAL_TIMEZONE): number {
  const d = toDate(instant)
  const p = localParts(d, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000)
}

function parseDay(day: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) throw new Error(`not a day (YYYY-MM-DD): ${day}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function parseTime(time: string): [number, number] {
  const m = /^(\d{2}):(\d{2})$/.exec(time)
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`not a time (HH:mm): ${time}`)
  return [Number(m[1]), Number(m[2])]
}

/**
 * A Bucharest wall-clock time to the instant. Across DST:
 *  - a time that happens twice (03:30 on the October Sunday) is the FIRST one;
 *  - a time that never happens (03:30 on the March Sunday) moves forward by the
 *    gap (04:30), like every calendar app.
 */
export function zonedLocalToUtc(day: string, time: string, tz = SOCIAL_TIMEZONE): Date {
  const [y, mo, d] = parseDay(day)
  const [h, mi] = parseTime(time)
  const wall = Date.UTC(y, mo - 1, d, h, mi)
  const DAY = 24 * 3600 * 1000
  const offsets = [...new Set([offsetMinutes(wall - DAY, tz), offsetMinutes(wall + DAY, tz)])]
  const matches = offsets
    .map((o) => wall - o * 60000)
    .filter((t) => {
      const p = localParts(t, tz)
      return p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi
    })
    .sort((a, b) => a - b)
  if (matches.length > 0) return new Date(matches[0])
  // In the gap: use the offset in force BEFORE the change, which lands after it.
  return new Date(wall - offsetMinutes(wall - DAY, tz) * 60000)
}

/** Local midnight to next local midnight, as UTC instants. */
export function dayBoundsUtc(day: string, tz = SOCIAL_TIMEZONE): { start: Date; end: Date } {
  const [y, mo, d] = parseDay(day)
  const next = new Date(Date.UTC(y, mo - 1, d + 1))
  const nextDay = `${pad(next.getUTCFullYear(), 4)}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`
  return { start: zonedLocalToUtc(day, '00:00', tz), end: zonedLocalToUtc(nextDay, '00:00', tz) }
}

/** For <input type="date"> / <input type="time"> in Bucharest time. */
export function toLocalInputs(instant: Date | string | number, tz = SOCIAL_TIMEZONE): { date: string; time: string } {
  const p = localParts(instant, tz)
  return { date: `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` }
}

const displayFormatter = new Intl.DateTimeFormat('ro-RO', {
  timeZone: SOCIAL_TIMEZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** "2 nov. 2026, 10:00" in Bucharest time. */
export function formatBucharest(instant: Date | string | number | null | undefined): string {
  if (instant === null || instant === undefined || instant === '') return '-'
  try {
    return displayFormatter.format(toDate(instant))
  } catch {
    return '-'
  }
}

/** ISO 8601 UTC to the second: "2026-11-02T08:00:00Z". */
export function toIsoSeconds(instant: Date | string | number): string {
  const d = toDate(instant)
  return new Date(Math.floor(d.getTime() / 1000) * 1000).toISOString().replace('.000Z', 'Z')
}

// ---------------------------------------------------------------------------
// Daily cap (PRD 5)
// ---------------------------------------------------------------------------

export interface CapItem {
  accountId: string
  scheduledAt: Date | string
}

export interface CapViolation {
  accountId: string
  day: string
  used: number
  adding: number
  cap: number
}

/**
 * Would adding these destinations break any account's cap? `existing` are the
 * account's destinations that already count (approved and scheduled, or
 * published) - the caller filters by status; `caps` defaults to 5.
 */
export function checkDailyCap(
  existing: ReadonlyArray<CapItem>,
  adding: ReadonlyArray<CapItem>,
  caps: Readonly<Record<string, number>> = {}
): CapViolation[] {
  const key = (i: CapItem) => `${i.accountId}|${bucharestDay(i.scheduledAt)}`
  const used = new Map<string, number>()
  for (const i of existing) used.set(key(i), (used.get(key(i)) ?? 0) + 1)
  const add = new Map<string, number>()
  for (const i of adding) add.set(key(i), (add.get(key(i)) ?? 0) + 1)

  const out: CapViolation[] = []
  for (const [k, n] of add) {
    const [accountId, day] = k.split('|')
    const cap = Math.min(caps[accountId] ?? MAX_DAILY_CAP, MAX_DAILY_CAP)
    const u = used.get(k) ?? 0
    if (u + n > cap) out.push({ accountId, day, used: u, adding: n, cap })
  }
  return out
}
