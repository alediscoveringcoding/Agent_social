import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildDraftRevision, type BaseRevision, type DraftEdit, type EditAccount } from '../draft-edit.ts'
import { legalNamesFromEnv } from '../content-rules.ts'
import type { CardSpec } from '../cards/spec.ts'
import { unlistedFigures } from '../figures.ts'
import { cardCopyIssues } from '../cards/copy.ts'

export async function loadMediaRevision(postId: string, baseRevisionId: string) {
  const db = createAdminClient()
  const p = await db.from('social_posts').select('id, kind, title, status, cancelled_at, brand_id, current_revision_id, brand:social_brands(slug, name)').eq('id', postId).single()
  if (p.error) throw new Error('Ciorna nu exista.')
  const post = p.data as unknown as { id: string; kind: BaseRevision['kind']; title: string | null; status: string; cancelled_at: string | null; brand_id: string; current_revision_id: string; brand: { slug: string; name: string } }
  if (post.status !== 'draft' || post.cancelled_at) throw new Error('Redeschide postarea ca ciorna inainte de editarea imaginilor.')
  if (post.current_revision_id !== baseRevisionId) throw new Error('Ciorna s-a schimbat. Reincarca pagina.')
  const r = await db.from('social_post_revisions').select('canonical_text, figures, body_markdown, article, launch, card_spec, variants, notes, generator_errors').eq('id', baseRevisionId).single()
  const d = await db.from('social_destinations').select('account_id, text, settings, scheduled_at, media:social_destination_media(media_id, position, alt_text, file:social_media(mime, width, height))').eq('revision_id', baseRevisionId)
  const a = await db.from('social_accounts').select('id, platform, rules').eq('brand_id', post.brand_id)
  if (r.error || d.error || a.error) throw new Error('Nu am putut incarca revizia.')
  const rev = r.data as Omit<BaseRevision, 'kind' | 'title' | 'destinations'> & { canonical_text: string }
  const destinations = (d.data ?? []) as unknown as Array<{ account_id: string; text: string; settings: Record<string, unknown>; scheduled_at: string | null; media: Array<{ media_id: string; position: number; alt_text: string; file: { mime: string; width: number; height: number } | null }> }>
  const base: BaseRevision = { ...rev, kind: post.kind, title: post.title, figures: rev.figures ?? [], destinations: destinations.map((dest) => ({ account_id: dest.account_id, media: dest.media.map((m) => ({ media_id: m.media_id, position: m.position, alt_text: m.alt_text, ...m.file })) })) }
  const edit: DraftEdit = { title: post.title, canonicalText: rev.canonical_text, figures: rev.figures ?? [], destinations: destinations.map((dest) => ({ accountId: dest.account_id, text: dest.text, settings: dest.settings })) }
  return { db, post, base, edit, destinations, accounts: (a.data ?? []) as EditAccount[] }
}

export async function saveMediaRevision(context: Awaited<ReturnType<typeof loadMediaRevision>>, baseRevisionId: string, actor: { userId: string; email: string }, replacements: Map<string, BaseRevision['destinations'][number]['media']>, cardSpec?: CardSpec) {
  for (const accountId of replacements.keys()) if (!context.destinations.some((d) => d.account_id === accountId)) throw new Error('Destinatia nu apartine reviziei.')
  const base = { ...context.base, destinations: context.base.destinations.map((d) => ({ ...d, media: replacements.get(d.account_id) ?? d.media })) }
  // A changed card can introduce a new number even when caption copy is unchanged.
  // Carry it as unverified so approval requires the same human figure check.
  const mediaIds = [...new Set(base.destinations.flatMap((d) => d.media.map((m) => m.media_id)))]
  const files = mediaIds.length ? await context.db.from('social_media').select('card_spec').in('id', mediaIds) : { data: [], error: null }
  if (files.error) throw new Error('Nu am putut verifica imaginile.')
  const cards = ((files.data ?? []) as Array<{ card_spec: CardSpec | null }>).flatMap((m) => m.card_spec ? [m.card_spec] : [])
  if (cardSpec) cards.push(cardSpec)
  for (const card of cards) {
    const issues = cardCopyIssues(card, legalNamesFromEnv(process.env.SOCIAL_LEGAL_NAMES))
    if (issues.length) throw new Error(issues[0])
  }
  const extraFigures = unlistedFigures(cards.flatMap((card) => [card.headline, card.stat, card.subline]).filter(Boolean).join(' '), base.figures).map((f) => ({ value: f.value, source: 'unverified' as const, context: 'Card' }))
  const uniqueFigures = extraFigures.filter((f, i) => extraFigures.findIndex((other) => other.value === f.value) === i)
  const edit = { ...context.edit, figures: [...context.edit.figures, ...uniqueFigures] }
  const rows = buildDraftRevision(base, edit, context.accounts, { actorEmail: actor.email, legalNames: legalNamesFromEnv(process.env.SOCIAL_LEGAL_NAMES) })
  // Media-only edits carry the original schedule, including when W1 is absent.
  for (const d of rows.destinations) d.scheduled_at = context.destinations.find((before) => before.account_id === d.account_id)?.scheduled_at ?? null
  if (cardSpec) rows.revision.card_spec = cardSpec
  const { data, error } = await context.db.rpc('social_save_revision', { p_post: context.post.id, p_base_revision: baseRevisionId, p_actor: actor.userId, p_revision: rows.revision, p_destinations: rows.destinations, p_reason: 'media edit' })
  if (error) throw new Error(error.message.includes('SOCIAL_STALE_REVISION') ? 'Ciorna s-a schimbat. Reincarca pagina.' : error.message)
  return data as string
}
