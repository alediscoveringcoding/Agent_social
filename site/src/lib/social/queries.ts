import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { SOCIAL_BUCKET, type Platform, type PostKind } from './constants.ts'
import type { EditFigure } from './draft-edit.ts'
import type { StoredValidation } from './draft-mapping.ts'

/**
 * Reads for the drafting screens, with the service-role client. Callers have
 * passed requireAdminPage() / requireAdmin() already. Shapes are plain JSON
 * so they can go straight to client components.
 */

export interface Brand {
  id: string
  slug: string
  name: string
}

export interface AccountSummary {
  id: string
  brand_id: string | null
  platform: Platform
  display_name: string
  mode: 'auto' | 'manual'
  status: string
  paused: boolean
  rules: Record<string, unknown>
}

export interface GenerationRequestSummary {
  id: string
  brand: Brand | null
  input: {
    source?: { type: 'article'; url: string } | { type: 'topic'; topic: string; hooks?: string[] }
    platforms?: string[]
    count?: number
    templates?: string[]
    ai?: { provider: string; model: string }
  }
  status: 'queued' | 'running' | 'done' | 'failed'
  attempts: number
  error_code: string | null
  error_message: string | null
  drafts_created: number
  created_at: string
  finished_at: string | null
  requested_by_email: string | null
}

export interface DraftSummary {
  id: string
  brand: Brand | null
  kind: PostKind
  title: string | null
  created_at: string
  updated_at: string
  generation_request_id: string | null
  revision: { id: string; number: number; created_at: string; notes: string | null; generator_errors: Array<{ code?: string; message: string }> } | null
  destinations: Array<{ id: string; platform: Platform; account: string; ok: boolean; errors: string[]; warnings: number }>
  unverified_figures: number
}

export interface DraftDestination {
  id: string
  account_id: string
  platform: Platform
  account_name: string
  text: string
  settings: Record<string, unknown>
  contains_figures: boolean
  validation: Partial<StoredValidation>
  // W2: each rendered attachment retains its own spec after partial generation.
  media: Array<{ media_id: string; position: number; alt_text: string; mime: string; width: number; height: number; url: string | null; card_spec?: Record<string, unknown> | null }>
}

export interface DraftDetail {
  id: string
  brand: Brand
  kind: PostKind
  title: string | null
  status: string
  source_url: string | null
  generation_request_id: string | null
  revision: {
    id: string
    number: number
    canonical_text: string
    article: Record<string, unknown> | null
    launch: Record<string, unknown> | null
    card_spec: Record<string, unknown> | null
    figures: EditFigure[]
    variants: Array<{ platform: Platform; text: string; settings?: Record<string, unknown> | null }>
    notes: string | null
    generator_errors: Array<{ code?: string; message: string }>
    created_at: string
  }
  destinations: DraftDestination[]
  accounts: AccountSummary[]
  revisions: Array<{ id: string; number: number; created_at: string; created_by_email: string | null }>
}

function must<T>(res: { data: unknown; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data as T
}

export async function listBrands(): Promise<Brand[]> {
  const admin = createAdminClient()
  return must<Brand[]>(await admin.from('social_brands').select('id, slug, name').order('name'), 'brands') ?? []
}

export async function listAccounts(brandId?: string): Promise<AccountSummary[]> {
  const admin = createAdminClient()
  let q = admin
    .from('social_accounts')
    .select('id, brand_id, platform, display_name, mode, status, paused, rules')
    .order('platform')
  if (brandId) q = q.eq('brand_id', brandId)
  return must<AccountSummary[]>(await q, 'accounts') ?? []
}

export async function listGenerationRequests(limit = 20): Promise<GenerationRequestSummary[]> {
  const admin = createAdminClient()
  const rows = must<Array<Omit<GenerationRequestSummary, 'requested_by_email'> & { requested_by: string | null }>>(
    await admin
      .from('social_generation_requests')
      .select('id, brand:social_brands(id, slug, name), input, status, attempts, error_code, error_message, drafts_created, created_at, finished_at, requested_by')
      .order('created_at', { ascending: false })
      .limit(limit),
    'generation requests'
  ) ?? []
  const actors = [...new Set(rows.map((r) => r.requested_by).filter(Boolean))] as string[]
  const emails = new Map<string, string>()
  if (actors.length) {
    const log = must<Array<{ actor_id: string; actor_email: string }>>(
      await admin.from('social_activity_log').select('actor_id, actor_email').in('actor_id', actors).limit(200),
      'actors'
    ) ?? []
    for (const l of log) if (l.actor_email) emails.set(l.actor_id, l.actor_email)
  }
  return rows.map(({ requested_by, ...r }) => ({ ...r, requested_by_email: requested_by ? emails.get(requested_by) ?? null : null }))
}

interface DraftRow {
  id: string
  kind: PostKind
  title: string | null
  created_at: string
  updated_at: string
  generation_request_id: string | null
  current_revision_id: string | null
  brand: Brand | null
}

export async function listDrafts(): Promise<DraftSummary[]> {
  const admin = createAdminClient()
  const posts = must<DraftRow[]>(
    await admin
      .from('social_posts')
      .select('id, kind, title, created_at, updated_at, generation_request_id, current_revision_id, brand:social_brands(id, slug, name)')
      .eq('status', 'draft')
      .is('cancelled_at', null)
      .order('updated_at', { ascending: false })
      .limit(200),
    'drafts'
  ) ?? []
  const revisionIds = posts.map((p) => p.current_revision_id).filter(Boolean) as string[]
  if (!revisionIds.length) return posts.map((p) => ({ ...p, revision: null, destinations: [], unverified_figures: 0 }))

  type RevisionRow = {
    id: string
    number: number
    created_at: string
    notes: string | null
    generator_errors: Array<{ code?: string; message: string }> | null
    figures: EditFigure[] | null
  }
  const revisions = must<RevisionRow[]>(
    await admin.from('social_post_revisions').select('id, number, created_at, notes, generator_errors, figures').in('id', revisionIds),
    'revisions'
  ) ?? []
  const dests = must<Array<{ id: string; revision_id: string; platform: Platform; validation: Partial<StoredValidation>; account: { display_name: string } | null }>>(
    await admin
      .from('social_destinations')
      .select('id, revision_id, platform, validation, account:social_accounts(display_name)')
      .in('revision_id', revisionIds)
      .order('platform'),
    'destinations'
  ) ?? []
  const revById = new Map(revisions.map((r) => [r.id, r]))

  return posts.map((p) => {
    const rev = p.current_revision_id ? revById.get(p.current_revision_id) : undefined
    return {
      id: p.id,
      brand: p.brand,
      kind: p.kind,
      title: p.title,
      created_at: p.created_at,
      updated_at: p.updated_at,
      generation_request_id: p.generation_request_id,
      revision: rev
        ? { id: rev.id, number: rev.number, created_at: rev.created_at, notes: rev.notes, generator_errors: rev.generator_errors ?? [] }
        : null,
      destinations: dests
        .filter((d) => d.revision_id === p.current_revision_id)
        .map((d) => ({
          id: d.id,
          platform: d.platform,
          account: d.account?.display_name ?? '-',
          ok: d.validation?.ok !== false,
          errors: (d.validation?.errors ?? []).map((e) => e.code),
          warnings: (d.validation?.warnings ?? []).length,
        })),
      unverified_figures: (rev?.figures ?? []).filter((f) => f.source === 'unverified').length,
    }
  })
}

export async function getDraft(postId: string): Promise<DraftDetail | null> {
  const admin = createAdminClient()
  const post = must<(DraftRow & { status: string; source_url: string | null; brand: Brand }) | null>(
    await admin
      .from('social_posts')
      .select('id, kind, title, status, source_url, created_at, updated_at, generation_request_id, current_revision_id, brand:social_brands(id, slug, name)')
      .eq('id', postId)
      .maybeSingle(),
    'post'
  )
  if (!post || !post.current_revision_id) return null

  const [revision, destinations, revisions, accounts] = await Promise.all([
    admin
      .from('social_post_revisions')
      .select('id, number, canonical_text, article, launch, card_spec, figures, variants, notes, generator_errors, created_at')
      .eq('id', post.current_revision_id)
      .single()
      .then((r) => must<DraftDetail['revision']>(r, 'revision')),
    admin
      .from('social_destinations')
      .select(
        // W2: preview/studio reads the immutable spec of the attached card.
        'id, account_id, platform, text, settings, contains_figures, validation, account:social_accounts(display_name), media:social_destination_media(media_id, position, alt_text, file:social_media(mime, width, height, storage_path, card_spec))'
      )
      .eq('revision_id', post.current_revision_id)
      .order('platform')
      .then((r) =>
        must<
          Array<
            Omit<DraftDestination, 'account_name' | 'media'> & {
              account: { display_name: string } | null
              media: Array<{ media_id: string; position: number; alt_text: string; file: { mime: string; width: number; height: number; storage_path: string; card_spec: Record<string, unknown> | null } | null }>
            }
          >
        >(r, 'destinations')
      ),
    admin
      .from('social_post_revisions')
      .select('id, number, created_at, created_by')
      .eq('post_id', postId)
      .order('number', { ascending: false })
      .then((r) => must<Array<{ id: string; number: number; created_at: string; created_by: string | null }>>(r, 'revisions')),
    listAccounts(post.brand.id),
  ])

  const paths = destinations.flatMap((d) => d.media.map((m) => m.file?.storage_path)).filter(Boolean) as string[]
  const signed = new Map<string, string>()
  if (paths.length) {
    const { data } = await admin.storage.from(SOCIAL_BUCKET).createSignedUrls([...new Set(paths)], 600)
    for (const s of data ?? []) if (s.path && s.signedUrl) signed.set(s.path, s.signedUrl)
  }

  const actorIds = [...new Set(revisions.map((r) => r.created_by).filter(Boolean))] as string[]
  const emails = new Map<string, string>()
  if (actorIds.length) {
    const rows = must<Array<{ actor_id: string; actor_email: string }>>(
      await admin.from('social_activity_log').select('actor_id, actor_email').in('actor_id', actorIds).limit(200),
      'actors'
    ) ?? []
    for (const r of rows) if (r.actor_email) emails.set(r.actor_id, r.actor_email)
  }

  return {
    id: post.id,
    brand: post.brand,
    kind: post.kind,
    title: post.title,
    status: post.status,
    source_url: post.source_url,
    generation_request_id: post.generation_request_id,
    revision: { ...revision, figures: revision.figures ?? [], variants: revision.variants ?? [], generator_errors: revision.generator_errors ?? [] },
    destinations: destinations.map(({ account, media, ...d }) => ({
      ...d,
      account_name: account?.display_name ?? '-',
      media: media
        .filter((m) => m.file)
        .sort((a, b) => a.position - b.position)
        .map((m) => ({
          media_id: m.media_id,
          position: m.position,
          alt_text: m.alt_text,
          mime: m.file!.mime,
          width: m.file!.width,
          height: m.file!.height,
          url: signed.get(m.file!.storage_path) ?? null,
          // W2: this may differ from revision.card_spec on another destination.
          card_spec: m.file!.card_spec ?? null,
        })),
    })),
    accounts: accounts.filter((a) => a.brand_id === post.brand.id),
    revisions: revisions.map((r) => ({
      id: r.id,
      number: r.number,
      created_at: r.created_at,
      created_by_email: r.created_by ? emails.get(r.created_by) ?? null : null,
    })),
  }
}
