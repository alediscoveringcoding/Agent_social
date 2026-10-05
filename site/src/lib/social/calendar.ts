/**
 * Week view in Bucharest time (PRD F10). Pure and browser-safe.
 *
 * Days are calendar dates ("YYYY-MM-DD"), stepped with UTC date arithmetic, so
 * a step is always one calendar day whatever the clock does. A day's bounds
 * come from dayBoundsUtc(): local midnight to local midnight, which is 23
 * hours on the last Sunday of March and 25 on the last Sunday of October.
 * An instant belongs to the Bucharest day bucharestDay() gives it.
 */

import { bucharestDay, dayBoundsUtc, localParts } from './time.ts'

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function parse(day: string): Date {
  const m = DAY_RE.exec(day)
  if (!m) throw new Error(`not a day (YYYY-MM-DD): ${day}`)
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    throw new Error(`not a calendar day: ${day}`)
  }
  return d
}

function fmt(d: Date): string {
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

export function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false
  try {
    parse(value)
    return true
  } catch {
    return false
  }
}

export function addDays(day: string, n: number): string {
  const d = parse(day)
  d.setUTCDate(d.getUTCDate() + n)
  return fmt(d)
}

/** 0 = Monday ... 6 = Sunday. */
export function weekdayIndex(day: string): number {
  return (parse(day).getUTCDay() + 6) % 7
}

/** The Monday of the week that holds `day`. */
export function mondayOf(day: string): string {
  return addDays(day, -weekdayIndex(day))
}

/** The week to show: `?week=YYYY-MM-DD` (any day of it), else this week in Bucharest. */
export function resolveWeek(param: unknown, now: Date = new Date()): string {
  return mondayOf(isDay(param) ? param : bucharestDay(now))
}

export function weekDays(monday: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i))
}

/** UTC bounds of the week: Monday 00:00 to next Monday 00:00, Bucharest time. */
export function weekBoundsUtc(monday: string): { start: Date; end: Date } {
  return { start: dayBoundsUtc(monday).start, end: dayBoundsUtc(addDays(monday, 7)).start }
}

/** Items per Bucharest day of the week, each day sorted by time. Items outside the week are dropped. */
export function groupByDay<T>(items: readonly T[], days: readonly string[], at: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>(days.map((d) => [d, []]))
  for (const item of items) out.get(bucharestDay(at(item)))?.push(item)
  for (const list of out.values()) list.sort((a, b) => new Date(at(a)).getTime() - new Date(at(b)).getTime())
  return out
}

/** Hours in that Bucharest day: 24, or 23 / 25 on a DST change. */
export function dayLengthHours(day: string): number {
  const { start, end } = dayBoundsUtc(day)
  return Math.round((end.getTime() - start.getTime()) / 3_600_000)
}

const WEEKDAYS = ['Luni', 'Marti', 'Miercuri', 'Joi', 'Vineri', 'Sambata', 'Duminica']
const MONTHS = ['ian.', 'feb.', 'mar.', 'apr.', 'mai', 'iun.', 'iul.', 'aug.', 'sept.', 'oct.', 'nov.', 'dec.']

/** "Luni" and "26 oct." (no diacritics, unlike Intl's ro-RO weekdays). */
export function dayHeading(day: string): { weekday: string; date: string } {
  const d = parse(day)
  return { weekday: WEEKDAYS[weekdayIndex(day)], date: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` }
}

/** "26 oct. - 1 nov. 2026" */
export function weekLabel(monday: string): string {
  const end = addDays(monday, 6)
  const a = dayHeading(monday).date
  const b = dayHeading(end).date
  return `${a} - ${b} ${parse(end).getUTCFullYear()}`
}

/** "09:00" in Bucharest. */
export function timeOfDay(instant: string | Date): string {
  const p = localParts(instant)
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}
