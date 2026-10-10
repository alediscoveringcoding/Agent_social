/** Pure helpers for the draft editor, kept apart so they can be tested. */

/** Splits a comma separated tag field into trimmed, non-empty tags. */
export function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

/** The text shown in the tag input for a stored value. */
export function tagsToText(value: unknown): string {
  if (Array.isArray(value)) return (value as unknown[]).map(String).join(', ')
  return typeof value === 'string' ? value : ''
}

/** True while the alt text still equals the last auto-generated value. */
export function altIsAuto(current: string | undefined | null, lastAuto: string): boolean {
  return !current || current === lastAuto
}

/** True when a card with a figure has an alt text that no longer mentions it. */
export function altMissesFigure(alt: string | undefined | null, stat: string | undefined | null): boolean {
  const figure = (stat ?? '').trim()
  if (!figure) return false
  return !(alt ?? '').includes(figure)
}

/** Half filled date and time: one of the two is set, the other blank. */
export function halfFilledTime(time: { date: string; time: string } | undefined): boolean {
  if (!time) return false
  return Boolean(time.date) !== Boolean(time.time)
}
