/**
 * A generator Draft (PRD 10.5) to the rows of a new post: one destination per
 * brand account on each variant's platform, with the neutral settings of
 * PRD 10.5 filled from the article / launch fields. Pure, so it is tested
 * without a database.
 *
 * Choices worth knowing:
 *  - Every figure of the draft goes on every destination. The card (with its
 *    gold stat) is attached to all of them, so a figure "only in the X text"
 *    is still on the Instagram image.
 *  - A variant for a platform where the brand has no account is kept on the
 *    revision (`variants`) and named in the reviewer notes; nothing is lost.
 *  - The canonical URL of an article defaults to the draft's source article.
 */

import { isPlatform, PLATFORM_KIND, type Platform } from './constants.ts'
import type { DraftInput } from './schemas.ts'
import { validateDestination, type DestinationValidation } from './validation.ts'

export interface BrandAccount {
  id: string
  platform: Platform
  display_name: string
  rules?: Record<string, unknown> | null
}

export interface MappedDestination {
  account_id: string
  platform: Platform
  text: string
  settings: Record<string, unknown>
  scheduled_at: null
  figures: DraftInput['figures']
  contains_figures: boolean
  validation: StoredValidation
  media: []
}

export interface StoredValidation {
  ok: boolean
  errors: DestinationValidation['errors']
  warnings: DestinationValidation['warnings']
  length: number
  max_length: number | null
  checked_at: string
}

export interface MappedDraft {
  post: {
    kind: DraftInput['kind']
    title: string | null
    source_url: string | null
  }
  revision: {
    canonical_text: string
    body_markdown: string | null
    article: DraftInput['article'] | null
    launch: DraftInput['launch'] | null
    card_spec: DraftInput['card'] | null
    figures: DraftInput['figures']
    variants: DraftInput['variants']
    notes: string | null
    generator_errors: Array<{ code?: string; message: string }>
  }
  destinations: MappedDestination[]
  unmatchedPlatforms: Platform[]
}

function clean(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(settings)) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v) && v.length === 0) continue
    out[k] = v
  }
  return out
}

export function settingsFor(platform: Platform, draft: DraftInput, variantSettings: Record<string, unknown>) {
  const a = draft.article
  const l = draft.launch
  const canonical = a?.canonical_url || draft.source_url || undefined
  switch (platform) {
    case 'x':
      return clean({ who_can_reply: 'everyone', ...variantSettings })
    case 'instagram':
      return clean({ post_type: 'post', ...variantSettings })
    case 'facebook':
    case 'linkedin-page':
    case 'linkedin':
    case 'threads':
    case 'bluesky':
    case 'mastodon':
    case 'telegram':
    case 'nostr':
    case 'discord':
    case 'farcaster':
      return clean({ ...variantSettings })
    case 'reddit':
      // The generator suggests the title; the subreddit is chosen by a person.
      return clean({ post_type: 'self', ...variantSettings })
    case 'pinterest':
      // The pin links to the source article unless the variant says otherwise.
      return clean({ link: draft.source_url ?? undefined, ...variantSettings })
    case 'lemmy':
      return clean({ ...variantSettings })
    case 'medium':
      return clean({
        title: a?.title,
        subtitle: a?.subtitle ?? undefined,
        tags: a?.tags ?? undefined,
        canonical_url: canonical,
        ...variantSettings,
      })
    case 'devto':
      return clean({ title: a?.title, tags: a?.tags ?? undefined, canonical_url: canonical, ...variantSettings })
    case 'hashnode':
      return clean({
        title: a?.title,
        subtitle: a?.subtitle ?? undefined,
        tags: a?.tags ?? undefined,
        canonical_url: canonical,
        ...variantSettings,
      })
    case 'substack':
      return clean({ title: a?.title, subtitle: a?.subtitle ?? undefined, ...variantSettings })
    case 'producthunt':
      return clean({ name: l?.name, tagline: l?.tagline, maker_comment: l?.maker_comment ?? undefined, ...variantSettings })
  }
}

function textFor(platform: Platform, draft: DraftInput, variantText: string): string {
  if (variantText.trim()) return variantText
  if (platform === 'producthunt') return draft.launch?.description ?? ''
  if (draft.article && PLATFORM_KIND[platform] === 'article') {
    return draft.article.body_markdown
  }
  return ''
}

export function toStoredValidation(v: DestinationValidation, now: Date, ignore: readonly string[] = []): StoredValidation {
  const errors = v.errors.filter((e) => !ignore.includes(e.code))
  return {
    ok: errors.length === 0,
    errors,
    warnings: v.warnings,
    length: v.length,
    max_length: v.maxLength,
    checked_at: now.toISOString(),
  }
}

function titleOf(draft: DraftInput): string | null {
  const t = draft.title || draft.article?.title || draft.launch?.name
  if (t) return t.slice(0, 300)
  const first = draft.canonical_text.trim().split('\n')[0] ?? ''
  return first ? first.slice(0, 80) : null
}

export function mapDraft(
  draft: DraftInput,
  accounts: ReadonlyArray<BrandAccount>,
  opts: { legalNames?: ReadonlyArray<string>; now?: Date } = {}
): MappedDraft {
  const now = opts.now ?? new Date()
  const destinations: MappedDestination[] = []
  const unmatched: Platform[] = []
  const unknown: string[] = []
  const seenAccounts = new Set<string>()

  for (const variant of draft.variants) {
    if (!isPlatform(variant.platform)) {
      if (!unknown.includes(variant.platform)) unknown.push(variant.platform)
      continue
    }
    const platform = variant.platform
    const matching = accounts.filter((a) => a.platform === platform)
    if (matching.length === 0) {
      if (!unmatched.includes(platform)) unmatched.push(platform)
      continue
    }
    for (const acc of matching) {
      if (seenAccounts.has(acc.id)) continue
      seenAccounts.add(acc.id)
      const settings = settingsFor(platform, draft, (variant.settings ?? {}) as Record<string, unknown>)
      const text = textFor(platform, draft, variant.text)
      const v = validateDestination({
        platform,
        kind: draft.kind,
        text,
        settings,
        media: [],
        figures: draft.figures,
        scheduledAt: null,
        now,
        rules: acc.rules ?? null,
        legalNames: opts.legalNames ?? [],
      })
      destinations.push({
        account_id: acc.id,
        platform,
        text,
        settings,
        scheduled_at: null,
        figures: draft.figures,
        contains_figures: v.containsFigures,
        // The time is chosen in the composer; a draft is not "invalid" for lacking one yet.
        validation: toStoredValidation(v, now, ['MISSING_TIME']),
        media: [],
      })
    }
  }

  const notes = [draft.notes ?? '']
  if (unmatched.length) notes.push(`Fara cont conectat pentru: ${unmatched.join(', ')}. Variantele sunt pastrate in revizie.`)
  if (unknown.length) {
    notes.push(`Platforme necunoscute in ciorna: ${unknown.join(', ')}. Variantele sunt pastrate in revizie, fara destinatie.`)
  }

  return {
    post: { kind: draft.kind, title: titleOf(draft), source_url: draft.source_url ?? null },
    revision: {
      canonical_text: draft.canonical_text,
      body_markdown: draft.article?.body_markdown ?? null,
      article: draft.article ?? null,
      launch: draft.launch ?? null,
      card_spec: draft.card ?? null,
      figures: draft.figures,
      variants: draft.variants,
      notes: notes.filter(Boolean).join('\n') || null,
      generator_errors: draft.validation_errors.map((e) => (typeof e === 'string' ? { message: e } : e)),
    },
    destinations,
    unmatchedPlatforms: unmatched,
  }
}
