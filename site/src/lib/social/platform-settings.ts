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
  /** For `tags` fields: how many the editor says are allowed. */
  maxItems?: number
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

/** Postiz GmbSettingsDto callToActionType. */
export const GMB_CTA_TYPES = ['NONE', 'BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'GET_OFFER', 'CALL'] as const
export const GMB_CTA_LABELS: Record<(typeof GMB_CTA_TYPES)[number], string> = {
  NONE: 'Fara buton',
  BOOK: 'Rezerva',
  ORDER: 'Comanda',
  SHOP: 'Cumpara',
  LEARN_MORE: 'Afla mai multe',
  SIGN_UP: 'Inscrie-te',
  GET_OFFER: 'Primeste oferta',
  CALL: 'Suna',
}
/** CTA types whose button needs a link (CALL uses the profile's phone number). */
export const GMB_CTA_NEEDS_URL = ['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'GET_OFFER'] as const

export const MEWE_POST_TYPES = ['timeline', 'group'] as const
export const MEWE_POST_TYPE_LABELS = { timeline: 'Profil', group: 'Grup' } as const

export const TWITCH_MESSAGE_TYPES = ['message', 'announcement'] as const
export const TWITCH_MESSAGE_LABELS = { message: 'Mesaj in chat', announcement: 'Anunt' } as const
export const TWITCH_ANNOUNCEMENT_COLORS = ['primary', 'blue', 'green', 'orange', 'purple'] as const

/** Postiz TikTokDto privacy_level. Unaudited apps can only post privately, so SELF_ONLY is the default. */
export const TIKTOK_PRIVACY_LEVELS = ['SELF_ONLY', 'FOLLOWER_OF_CREATOR', 'MUTUAL_FOLLOW_FRIENDS', 'PUBLIC_TO_EVERYONE'] as const
export const TIKTOK_PRIVACY_LABELS = {
  SELF_ONLY: 'Doar eu',
  FOLLOWER_OF_CREATOR: 'Urmaritorii',
  MUTUAL_FOLLOW_FRIENDS: 'Prietenii (urmarire reciproca)',
  PUBLIC_TO_EVERYONE: 'Public',
} as const

/** WordPress statuses Postiz accepts. */
export const WORDPRESS_STATUSES = ['publish', 'draft', 'pending', 'private'] as const
export const WORDPRESS_STATUS_LABELS = { publish: 'Publicat', draft: 'Ciorna', pending: 'In asteptare', private: 'Privat' } as const

const options = <T extends string>(values: readonly T[], labels: Record<T, string>) => values.map((value) => ({ value, label: labels[value] }))

export const SETTINGS_FIELDS: Partial<Record<Platform, readonly SettingsField[]>> = {
  slack: [{ key: 'channel', label: 'Canal (id)', required: true, hint: 'Id-ul canalului Slack, de forma C0123ABCD.' }],
  wordpress: [
    { key: 'title', label: 'Titlu', required: true },
    { key: 'post_type', label: 'Tip de continut', hint: 'post (implicit) sau page.' },
    { key: 'status', label: 'Stare', kind: 'select', options: options(WORDPRESS_STATUSES, WORDPRESS_STATUS_LABELS) },
  ],
  listmonk: [
    { key: 'title', label: 'Subiectul e-mailului', required: true },
    { key: 'subtitle', label: 'Text de previzualizare', hint: 'Primele cuvinte din inbox.' },
    { key: 'list', label: 'Lista (id)', required: true, hint: 'Id-ul numeric al listei de abonati.' },
    { key: 'template', label: 'Sablon (id)', hint: 'Optional.' },
  ],
  gmb: [
    { key: 'cta_type', label: 'Buton', kind: 'select', options: options(GMB_CTA_TYPES, GMB_CTA_LABELS) },
    { key: 'cta_url', label: 'Link pentru buton', hint: 'Cerut pentru toate butoanele, mai putin "Fara buton" si "Suna".' },
  ],
  tumblr: [
    { key: 'title', label: 'Titlu', max: 4096, hint: 'Optional.' },
    { key: 'link', label: 'Link', hint: 'Optional (https://...).' },
    { key: 'source_url', label: 'Sursa', hint: 'Optional (https://...).' },
    { key: 'tags', label: 'Etichete', kind: 'tags', hint: 'Separate prin virgula.' },
  ],
  dribbble: [
    { key: 'title', label: 'Titlu', required: true },
    { key: 'team', label: 'Echipa', hint: 'Optional, linkul paginii echipei.' },
  ],
  mewe: [
    { key: 'post_type', label: 'Unde', kind: 'select', options: options(MEWE_POST_TYPES, MEWE_POST_TYPE_LABELS) },
    { key: 'group', label: 'Grup (id)', hint: 'Doar pentru tipul Grup.' },
  ],
  skool: [
    { key: 'group', label: 'Grup', required: true, hint: 'Numele grupului din linkul Skool.' },
    { key: 'label', label: 'Categorie (id)', required: true },
    { key: 'title', label: 'Titlu', required: true },
  ],
  whop: [
    { key: 'company', label: 'Companie (id)', required: true },
    { key: 'experience', label: 'Forum (id)', required: true, hint: 'Id-ul experientei de tip forum.' },
    { key: 'title', label: 'Titlu', hint: 'Optional.' },
  ],
  moltbook: [{ key: 'submolt', label: 'Submolt', hint: 'Implicit general.' }],
  twitch: [
    { key: 'message_type', label: 'Tip', kind: 'select', options: options(TWITCH_MESSAGE_TYPES, TWITCH_MESSAGE_LABELS) },
    {
      key: 'announcement_color',
      label: 'Culoarea anuntului',
      kind: 'select',
      options: TWITCH_ANNOUNCEMENT_COLORS.map((value) => ({ value, label: value })),
    },
  ],
  tiktok: [
    { key: 'title', label: 'Titlu', max: 90, hint: 'Cel mult 90 de caractere.' },
    { key: 'privacy_level', label: 'Cine vede', kind: 'select', options: options(TIKTOK_PRIVACY_LEVELS, TIKTOK_PRIVACY_LABELS) },
  ],
  youtube: [
    { key: 'title', label: 'Titlu video', required: true, max: 100 },
    { key: 'tags', label: 'Etichete', kind: 'tags', maxItems: 15, hint: 'Separate prin virgula; impreuna cel mult 500 de caractere.' },
  ],
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
    { key: 'tags', label: 'Etichete', kind: 'tags', maxItems: 3, hint: 'Separate prin virgula, cel mult 3 (fiecare cel mult 25 de caractere).' },
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
