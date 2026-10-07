/**
 * Turning an edit from the drafts editor into the rows of a new revision
 * (saving an edit is always a new revision, PRD F4). Pure, so the rules are
 * tested without a database:
 *
 *  - settings are reduced to the neutral keys of PRD 10.5 for the platform;
 *    anything else the browser sends is dropped;
 *  - a figure the generator marked `unverified` stays unverified until a
 *    person confirms it (source `confirmed`, stamped with who and when) or
 *    removes it; nobody can relabel it `facts` or `article` from the browser;
 *  - every figure of the revision goes on every destination (as at ingest);
 *  - images stay attached to their account's destination across revisions;
 *  - validation is recomputed. The time is chosen at approval, so a missing
 *    time is not a drafting error.
 */

import { isPlatform, type Platform, type PostKind } from './constants.ts'
import type { DraftFigure } from './figures.ts'
import { toStoredValidation, type StoredValidation } from './draft-mapping.ts'
import { validateDestination } from './validation.ts'

export const SETTINGS_KEYS: Record<Platform, readonly string[]> = {
  x: ['who_can_reply'],
  instagram: ['post_type'],
  facebook: [],
  'linkedin-page': [],
  devto: ['title', 'tags', 'canonical_url', 'cover_media_id'],
  hashnode: ['title', 'subtitle', 'tags', 'canonical_url', 'cover_media_id'],
  substack: ['title', 'subtitle'],
  producthunt: ['name', 'tagline', 'maker_comment'],
  // Amendment 04. The fields of the platforms below are listed with their
  // labels in platform-settings.ts (a test keeps the two in step).
  threads: [],
  bluesky: [],
  mastodon: [],
  linkedin: [],
  reddit: ['subreddit', 'title', 'post_type', 'link_url', 'flair_id'],
  pinterest: ['board', 'title', 'link'],
  telegram: [],
  discord: ['channel'],
  medium: ['title', 'subtitle', 'tags', 'canonical_url'],
  farcaster: ['channel'],
  nostr: [],
  lemmy: ['community', 'community_id', 'title', 'link'],
  // Amendment 04, second batch.
  slack: ['channel'],
  wordpress: ['title', 'post_type', 'status'],
  listmonk: ['title', 'subtitle', 'list', 'template'],
  vk: [],
  gmb: ['cta_type', 'cta_url'],
  tumblr: ['title', 'link', 'source_url', 'tags'],
  dribbble: ['title', 'team'],
  mewe: ['post_type', 'group'],
  skool: ['group', 'label', 'title'],
  whop: ['company', 'experience', 'title'],
  moltbook: ['submolt'],
  kick: [],
  twitch: ['message_type', 'announcement_color'],
  tiktok: ['title', 'privacy_level'],
  youtube: ['title', 'tags'],
  // Amendment 05: manual-only channels.
  quora: ['target_url'],
  'linkedin-article': ['title', 'subtitle'],
  tradingview: ['symbol', 'title'],
  investing: ['instrument_url'],
  indiehackers: ['title', 'group'],
  stackexchange: ['site', 'post_type', 'question_url', 'title', 'tags'],
  github: ['repo', 'post_type', 'title', 'tag', 'category'],
  forum: ['thread_url', 'title'],
  press: ['title', 'subtitle'],
}

export const FIGURE_SOURCES = ['article', 'facts', 'unverified', 'confirmed'] as const

export interface EditFigure extends DraftFigure {
  confirmed_by?: string | null
  confirmed_at?: string | null
}

export interface DraftEdit {
  title?: string | null
  canonicalText: string
  figures: ReadonlyArray<EditFigure>
  destinations: ReadonlyArray<{ accountId: string; text: string; settings: Record<string, unknown> }>
}

export interface BaseRevision {
  kind: PostKind
  title: string | null
  figures: ReadonlyArray<EditFigure>
  // Carried over unchanged: every revision column the edit does not touch must
  // be copied, or saving drops it (the new row only has what is passed here).
  body_markdown: string | null
  article: unknown
  launch: unknown
  card_spec: unknown
  variants: unknown
  notes: string | null
  generator_errors: unknown
  destinations: ReadonlyArray<{
    account_id: string
    // W1: a time already chosen on the post page survives a text edit.
    scheduled_at?: string | null
    media: ReadonlyArray<{ media_id: string; position: number; alt_text: string; mime?: string | null; width?: number | null; height?: number | null }>
  }>
}

export interface EditAccount {
  id: string
  platform: string
  rules?: Record<string, unknown> | null
}

export class DraftEditError extends Error {}

export function sanitizeSettings(platform: Platform, settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of SETTINGS_KEYS[platform]) {
    const v = settings?.[key]
    if (v === undefined || v === null || v === '') continue
    if (key === 'tags') {
      const tags = (Array.isArray(v) ? v : String(v).split(','))
        .map((t) => String(t).trim())
        .filter(Boolean)
        .slice(0, 20)
      if (tags.length) out.tags = tags
      continue
    }
    if (typeof v === 'string') out[key] = v.slice(0, 5000)
  }
  return out
}

function figureKey(f: { value: string }): string {
  return f.value.trim().toLowerCase()
}

/** Apply the confirmation rules to the figures the editor sends. */
export function reconcileFigures(
  base: ReadonlyArray<EditFigure>,
  edited: ReadonlyArray<EditFigure>,
  actorEmail: string,
  now: Date
): EditFigure[] {
  const before = new Map(base.map((f) => [figureKey(f), f]))
  const out: EditFigure[] = []
  for (const f of edited) {
    const value = f.value.trim().slice(0, 100)
    if (!value) continue
    if (!(FIGURE_SOURCES as readonly string[]).includes(f.source)) throw new DraftEditError(`Sursa cifrei "${value}" nu e valida.`)
    const prev = before.get(figureKey(f))
    const context = (f.context ?? prev?.context ?? null)?.slice(0, 500) ?? null
    if (!prev) {
      // A figure a person adds is either confirmed by them or left unverified.
      if (f.source !== 'confirmed' && f.source !== 'unverified') {
        throw new DraftEditError(`Cifra noua "${value}" poate fi doar confirmata de tine sau lasata neverificata.`)
      }
    } else if (prev.source !== f.source) {
      const allowed = (prev.source === 'unverified' && f.source === 'confirmed') || (prev.source === 'confirmed' && f.source === 'unverified')
      if (!allowed) throw new DraftEditError(`Sursa cifrei "${value}" nu se poate schimba din ${prev.source} in ${f.source}.`)
    }
    const confirmedNow = f.source === 'confirmed' && prev?.source !== 'confirmed'
    out.push({
      value,
      context,
      source: f.source,
      ...(f.source === 'confirmed'
        ? {
            confirmed_by: confirmedNow ? actorEmail : (prev?.confirmed_by ?? actorEmail),
            confirmed_at: confirmedNow ? now.toISOString() : (prev?.confirmed_at ?? now.toISOString()),
          }
        : {}),
    })
  }
  return out
}

export interface RevisionRows {
  revision: Record<string, unknown>
  destinations: Array<Record<string, unknown> & { account_id: string; validation: StoredValidation }>
}

export function buildDraftRevision(
  base: BaseRevision,
  edit: DraftEdit,
  accounts: ReadonlyArray<EditAccount>,
  opts: { actorEmail: string; legalNames?: ReadonlyArray<string>; now?: Date }
): RevisionRows {
  const now = opts.now ?? new Date()
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const seen = new Set<string>()
  if (edit.destinations.length === 0) throw new DraftEditError('Alege cel putin o platforma.')

  const figures = reconcileFigures(base.figures, edit.figures, opts.actorEmail, now)
  const destinations: RevisionRows['destinations'] = []
  for (const d of edit.destinations) {
    const acc = byId.get(d.accountId)
    if (!acc || !isPlatform(acc.platform)) throw new DraftEditError('Unul dintre conturi nu mai apartine brandului.')
    if (seen.has(acc.id)) throw new DraftEditError('Un cont apare de doua ori.')
    seen.add(acc.id)
    const text = String(d.text ?? '').slice(0, 100_000)
    const settings = sanitizeSettings(acc.platform, d.settings ?? {})
    const media = base.destinations.find((b) => b.account_id === acc.id)?.media ?? []
    const v = validateDestination({
      platform: acc.platform,
      kind: base.kind,
      text,
      settings,
      media: media.map((m) => ({ mediaId: m.media_id, mime: m.mime ?? null, width: m.width ?? null, height: m.height ?? null, altText: m.alt_text })),
      figures,
      scheduledAt: null,
      now,
      rules: acc.rules ?? null,
      legalNames: opts.legalNames ?? [],
    })
    destinations.push({
      account_id: acc.id,
      text,
      settings,
      // W1: keep the destination's time (set on the post page); approval checks it again.
      scheduled_at: base.destinations.find((b) => b.account_id === acc.id)?.scheduled_at ?? null,
      figures,
      contains_figures: v.containsFigures,
      validation: toStoredValidation(v, now, ['MISSING_TIME']),
      media: media.map((m) => ({ media_id: m.media_id, position: m.position, alt_text: m.alt_text })),
    })
  }

  return {
    revision: {
      title: (edit.title ?? base.title ?? '').slice(0, 300) || null,
      canonical_text: String(edit.canonicalText ?? '').slice(0, 100_000),
      body_markdown: base.body_markdown ?? null,
      article: base.article ?? null,
      launch: base.launch ?? null,
      card_spec: base.card_spec ?? null,
      figures,
      variants: base.variants ?? [],
      notes: base.notes,
      generator_errors: base.generator_errors ?? [],
    },
    destinations,
  }
}
