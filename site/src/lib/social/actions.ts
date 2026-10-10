'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin, type AdminIdentity } from '@/lib/auth/admin'
import { AdminAuthError } from '@/lib/auth/decision'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Platform, PostKind } from './constants.ts'
import { legalNamesFromEnv } from './content-rules.ts'
import { buildDraftRevision, DraftEditError, type BaseRevision, type DraftEdit, type EditFigure } from './draft-edit.ts'
import { buildGenerationCandidate, generationIssueMessage, type GenerationFormValues } from './news-ui.ts'
import { GenerationInputSchema } from './schemas.ts'
import { logActivity } from './server/activity.ts'

/**
 * Server actions of the drafting flow (PRD F2 / A5, the editing half of F4).
 * Each one is a public endpoint: requireAdmin() first, every time. Writes go
 * through the SQL functions (one transaction each) and leave a row in
 * social_activity_log. Approval and scheduling are not here.
 */

export type ActionResult<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string }

const SQL_ERRORS: Record<string, string> = {
  SOCIAL_STALE_REVISION: 'Ciorna a fost salvata intre timp. Reincarca pagina si reaplica modificarile.',
  SOCIAL_POST_CANCELLED: 'Ciorna a fost renuntata intre timp.',
  SOCIAL_ACCOUNT_OTHER_BRAND: 'Unul dintre conturi nu apartine brandului postarii.',
  SOCIAL_ACCOUNT_NOT_FOUND: 'Unul dintre conturi nu mai exista.',
  SOCIAL_DESTINATION_IN_FLIGHT: 'O destinatie a fost deja trimisa si nu mai poate fi editata.',
  SOCIAL_NOT_CANCELLABLE: 'Postarea a plecat deja si nu mai poate fi anulata.',
}

function friendlySqlError(message: string): string | null {
  for (const [code, text] of Object.entries(SQL_ERRORS)) if (message.includes(code)) return text
  return null
}

async function guarded<T extends object>(
  label: string,
  body: (admin: AdminIdentity) => Promise<ActionResult<T>>
): Promise<ActionResult<T>> {
  try {
    return await body(await requireAdmin())
  } catch (e) {
    if (e instanceof AdminAuthError || e instanceof DraftEditError) return { ok: false, error: e.message }
    const friendly = e instanceof Error ? friendlySqlError(e.message) : null
    if (friendly) return { ok: false, error: friendly }
    console.error(`[social/actions] ${label} failed:`, e)
    return { ok: false, error: 'Ceva nu a mers. Incearca din nou; daca se repeta, verifica jurnalul serverului.' }
  }
}

function revalidateDrafting(postId?: string) {
  revalidatePath('/admin/social')
  revalidatePath('/admin/social/genereaza')
  revalidatePath('/admin/social/ciorne')
  if (postId) revalidatePath(`/admin/social/ciorne/${postId}`)
}

// ---------------------------------------------------------------------------
// Generate (F2): a generation request for the worker's generator
// ---------------------------------------------------------------------------

/**
 * Amendment 07: the source can also be recent news (`news`, a web search), and
 * `research` asks a topic to search the web first. The input is validated by
 * GenerationInputSchema below, so the worker reads exactly what is stored.
 */
export type GenerationRequestForm = GenerationFormValues

export async function createGenerationRequest(form: GenerationRequestForm): Promise<ActionResult<{ requestId: string }>> {
  return guarded<{ requestId: string }>('createGenerationRequest', async (actor) => {
    const db = createAdminClient()
    const built = buildGenerationCandidate(form)
    if (!built.ok) return { ok: false, error: built.error }
    const platforms = built.candidate.platforms as Platform[]
    const parsed = GenerationInputSchema.safeParse(built.candidate)
    if (!parsed.success) {
      const where = parsed.error.issues[0]?.path.join('.') ?? ''
      const sourceType = (built.candidate.source as { type?: string } | null | undefined)?.type
      return { ok: false, error: generationIssueMessage(where, sourceType) }
    }

    const { data: brand } = await db.from('social_brands').select('id').eq('id', form.brandId).maybeSingle()
    if (!brand) return { ok: false, error: 'Alege un brand.' }

    const { data, error } = await db
      .from('social_generation_requests')
      .insert({ brand_id: form.brandId, input: parsed.data, requested_by: actor.userId })
      .select('id')
      .single()
    if (error || !data) throw new Error(error?.message ?? 'insert returned nothing')
    const requestId = (data as { id: string }).id

    await logActivity(db, actor, {
      action: 'social.generation_requested',
      details: {
        request_id: requestId,
        brand_id: form.brandId,
        platforms,
        count: parsed.data.count,
        source: parsed.data.source.type,
        research: parsed.data.research,
        ai_model: parsed.data.ai?.model ?? null,
      },
    })
    revalidateDrafting()
    return { ok: true, requestId }
  })
}

// ---------------------------------------------------------------------------
// Drafts: save an edit as a new revision, discard
// ---------------------------------------------------------------------------

export interface SaveDraftInput {
  postId: string
  baseRevisionId: string
  edit: DraftEdit
}

interface PostRow {
  id: string
  brand_id: string
  kind: PostKind
  title: string | null
  status: string
  cancelled_at: string | null
  current_revision_id: string | null
}

async function loadDraftPost(db: ReturnType<typeof createAdminClient>, postId: string): Promise<PostRow | null> {
  const { data, error } = await db
    .from('social_posts')
    .select('id, brand_id, kind, title, status, cancelled_at, current_revision_id')
    .eq('id', postId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as PostRow | null) ?? null
}

export async function saveDraft(input: SaveDraftInput): Promise<ActionResult<{ revisionId: string; errors: number }>> {
  return guarded<{ revisionId: string; errors: number }>('saveDraft', async (actor) => {
    const db = createAdminClient()
    const post = await loadDraftPost(db, input.postId)
    if (!post || post.cancelled_at) return { ok: false, error: 'Ciorna nu mai exista.' }
    if (post.status !== 'draft') {
      return { ok: false, error: 'Postarea e deja aprobata. Editarea ei se face din ecranul de aprobare.' }
    }
    if (post.current_revision_id !== input.baseRevisionId) {
      return { ok: false, error: SQL_ERRORS.SOCIAL_STALE_REVISION }
    }

    const { data: rev, error: revError } = await db
      .from('social_post_revisions')
      .select('id, figures, body_markdown, article, launch, card_spec, variants, notes, generator_errors')
      .eq('id', input.baseRevisionId)
      .single()
    if (revError || !rev) throw new Error(revError?.message ?? 'revision missing')
    const { data: dests, error: destError } = await db
      .from('social_destinations')
      .select('account_id, scheduled_at, media:social_destination_media(media_id, position, alt_text, file:social_media(mime, width, height))')
      .eq('revision_id', input.baseRevisionId)
    if (destError) throw new Error(destError.message)
    const { data: accounts, error: accError } = await db
      .from('social_accounts')
      .select('id, platform, rules')
      .eq('brand_id', post.brand_id)
    if (accError) throw new Error(accError.message)

    const r = rev as Omit<BaseRevision, 'kind' | 'title' | 'destinations'> & { figures: EditFigure[] }
    const base: BaseRevision = {
      ...r,
      kind: post.kind,
      title: post.title,
      figures: r.figures ?? [],
      destinations: ((dests ?? []) as unknown as Array<{
        account_id: string
        scheduled_at: string | null
        media: Array<{ media_id: string; position: number; alt_text: string; file: { mime: string; width: number; height: number } | null }>
      }>).map((d) => ({
        account_id: d.account_id,
        scheduled_at: d.scheduled_at, // W1: the time survives a text edit
        media: d.media.map((m) => ({ media_id: m.media_id, position: m.position, alt_text: m.alt_text, mime: m.file?.mime, width: m.file?.width, height: m.file?.height })),
      })),
    }
    const rows = buildDraftRevision(base, input.edit, (accounts ?? []) as Array<{ id: string; platform: string; rules: Record<string, unknown> }>, {
      actorEmail: actor.email,
      legalNames: legalNamesFromEnv(process.env.SOCIAL_LEGAL_NAMES),
    })

    const { data: revisionId, error } = await db.rpc('social_save_revision', {
      p_post: post.id,
      p_base_revision: input.baseRevisionId,
      p_actor: actor.userId,
      p_revision: rows.revision,
      p_destinations: rows.destinations,
      p_reason: 'draft edit',
    })
    if (error) throw new Error(error.message)

    const errors = rows.destinations.reduce((n, d) => n + d.validation.errors.length, 0)
    await logActivity(db, actor, {
      action: 'social.draft_saved',
      postId: post.id,
      details: {
        revision_id: revisionId,
        base_revision_id: input.baseRevisionId,
        destinations: rows.destinations.map((d) => d.account_id),
        errors,
      },
    })
    revalidateDrafting(post.id)
    return { ok: true, revisionId: revisionId as string, errors }
  })
}

export async function discardDraft(postId: string): Promise<ActionResult> {
  return guarded('discardDraft', async (actor) => {
    const db = createAdminClient()
    const post = await loadDraftPost(db, postId)
    if (!post || post.cancelled_at) return { ok: false, error: 'Ciorna nu mai exista.' }
    if (post.status !== 'draft') return { ok: false, error: 'Doar o ciorna neaprobata poate fi renuntata de aici.' }
    const { error } = await db.rpc('social_cancel', { p_post: postId, p_job: null, p_actor: actor.userId })
    if (error) throw new Error(error.message)
    await logActivity(db, actor, { action: 'social.draft_discarded', postId, details: { title: post.title } })
    revalidateDrafting(postId)
    return { ok: true }
  })
}
