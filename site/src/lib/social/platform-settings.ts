/**
 * Per-destination settings of the platforms added in amendment 04 (the
 * neutral keys of PRD 10.5, which the worker maps to Postiz's provider
 * settings). One table drives the draft editor's fields, the preview lines and
 * the manual handoff fields, so the three cannot drift apart. Pure.
 *
 * The older platforms (X, Instagram, dev.to, Hashnode, Substack, Product
 * Hunt) keep their hand-written fields in the editor; their keys are in
 * draft-edit.ts.
 */

import type { Platform } from './constants.ts'

export interface SettingsField {
  key: string
  label: string
  hint?: string
  kind?: 'text' | 'tags' | 'select'
  options?: ReadonlyArray<{ value: string; label: string }>
  /** Shown in the label; the hard check lives in validation.ts. */
  required?: boolean
  /** Character limit shown beside the copy button. */
  max?: number
  /** Spans both columns of the editor grid. */
  wide?: boolean
}

export const REDDIT_POST_TYPES = ['self', 'link', 'media'] as const
export type RedditPostType = (typeof REDDIT_POST_TYPES)[number]

export const REDDIT_POST_TYPE_LABELS: Record<RedditPostType, string> = {
  self: 'Text',
  link: 'Link',
  media: 'Imagine',
}

export const SETTINGS_FIELDS: Partial<Record<Platform, readonly SettingsField[]>> = {
  reddit: [
    { key: 'subreddit', label: 'Subreddit', required: true, hint: 'De exemplu r/numele_comunitatii.' },
    { key: 'title', label: 'Titlu', required: true, max: 300, hint: 'Cel mult 300 de caractere.' },
    {
      key: 'post_type',
      label: 'Tip postare',
      kind: 'select',
      options: REDDIT_POST_TYPES.map((value) => ({ value, label: REDDIT_POST_TYPE_LABELS[value] })),
    },
    { key: 'link_url', label: 'Link', hint: 'Doar pentru tipul Link.' },
    { key: 'flair_id', label: 'Flair (id)', hint: 'Doar daca subreddit-ul cere flair; id-ul se vede in Postiz.' },
  ],
  pinterest: [
    { key: 'board', label: 'Board (id)', required: true, hint: 'Id-ul numeric al board-ului, din Postiz, nu numele.' },
    { key: 'title', label: 'Titlu', required: true, max: 100, hint: 'Cel mult 100 de caractere.' },
    { key: 'link', label: 'Link', required: true, hint: 'Unde duce pinul (https://...).', wide: true },
  ],
  discord: [{ key: 'channel', label: 'Canal (id)', required: true, hint: 'Id-ul numeric al canalului.' }],
  medium: [
    { key: 'title', label: 'Titlu', required: true },
    { key: 'subtitle', label: 'Subtitlu', required: true, hint: 'Postiz il cere; Medium nu are camp separat de subtitlu.' },
    { key: 'canonical_url', label: 'Link canonic', required: true, hint: 'Articolul de pe blogul nostru.' },
    { key: 'tags', label: 'Etichete', kind: 'tags', hint: 'Separate prin virgula, cel mult 3 (fiecare cel mult 25 de caractere).' },
  ],
  farcaster: [{ key: 'channel', label: 'Canal', hint: 'Optional. De exemplu founders.' }],
  lemmy: [
    { key: 'community', label: 'Comunitate', required: true, hint: 'Numele comunitatii, fara instanta.' },
    { key: 'community_id', label: 'Comunitate (id)', required: true, hint: 'Id-ul numeric al comunitatii.' },
    { key: 'title', label: 'Titlu', required: true, max: 200, hint: 'Intre 3 si 200 de caractere.' },
    { key: 'link', label: 'Link', hint: 'Optional (https://...).' },
  ],
}

/** Keys the editor and the sanitizer accept for a platform in this table. */
export function settingsFieldKeys(platform: Platform): string[] {
  return (SETTINGS_FIELDS[platform] ?? []).map((f) => f.key)
}

const s = (v: unknown): string => (typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.map(String).join(', ') : '')

/** "Subreddit: r/x" style lines for the preview and the handoff (title excluded: it has its own place). */
export function settingsSummary(platform: Platform, settings: Record<string, unknown>): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = []
  for (const f of SETTINGS_FIELDS[platform] ?? []) {
    if (f.key === 'title') continue
    let value = s(settings[f.key])
    if (!value) continue
    if (f.kind === 'select') value = f.options?.find((o) => o.value === value)?.label ?? value
    out.push({ label: f.label, value })
  }
  return out
}
