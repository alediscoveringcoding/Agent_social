'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { legalNamesFromEnv } from './content-rules.ts'
import { buildDraftRevision, DraftEditError, type BaseRevision, type EditFigure } from './draft-edit.ts'
import type { PostKind } from './constants.ts'
import { logActivity } from './server/activity.ts'
import { ActionRefusal, callRpc, isUuid, runAdminAction, type ActionResult, type SqlMessages } from './server/run-admin-action.ts'

/**
 * Manual handoff (PRD flow 6.2, F8) and "duplicate a post as a new draft"
 * (F10, Should). requireAdmin() first; the state change is one SQL function
 * (social_mark_manual_done, social_create_post); each leaves an activity row.
 */

const MESSAGES: SqlMessages = {
  SOCIAL_JOB_NOT_FOUND: 'Destinatia nu mai exista. Reincarca pagina.',
  SOCIAL_NOT_MANUAL_PENDING: 'Destinatia nu mai asteapta publicarea manuala (a fost anulata sau marcata deja).',
  SOCIAL_URL_REQUIRED: 'Lipeste linkul public al postarii (https://...).',
  SOCIAL_ACCOUNT_OTHER_BRAND: 'Unul dintre conturi nu mai apartine brandului postarii.',
  SOCIAL_ACCOUNT_NOT_FOUND: 'Unul dintre conturi nu mai exista.',
}

const HTTPS = /^https:\/\/[^\s]+$/i

export async function markManualPublished(jobId: string, url: string): Promise<ActionResult<{ alreadyDone: boolean }>> {
  return runAdminAction<{ alreadyDone: boolean }>('markManualPublished', MESSAGES, async (actor) => {
    if (!isUuid(jobId)) return { ok: false, error: MESSAGES.SOCIAL_JOB_NOT_FOUND as string }
    const link = String(url ?? '').trim()
    if (!HTTPS.test(link) || link.length > 2048) return { ok: false, error: MESSAGES.SOCIAL_URL_REQUIRED as string }
    const db = createAdminClient()
    const result = await callRpc<{ ok: boolean; idempotent?: boolean }>(db, 'social_mark_manual_done', {
      p_job: jobId,
      p_actor: actor.userId,
      p_url: link,
    })
    const alreadyDone = result?.idempotent === true
    const { data: ctx } = await db.rpc('social_job_context', { p_job: jobId })
    const c = (ctx ?? {}) as { post_id?: string; platform?: string; account?: string }
    await logActivity(db, actor, {
      action: 'social.manual_done',
      jobId,
      postId: c.post_id ?? null,
      details: { url: link, platform: c.platform ?? null, account: c.account ?? null, already_done: alreadyDone },
    })
    revalidatePath('/admin/social')
    revalidatePath('/admin/social/manual')
    revalidatePath(`/admin/social/manual/${jobId}`)
    revalidatePath('/admin/social/calendar')
    if (c.post_id) revalidatePath(`/admin/social/postari/${c.post_id}`)
    return { ok: true, alreadyDone }
  })
}

interface SourcePost {
  id: string
  brand_id: string
  kind: PostKind
  title: string | null
  source_url: string | null
  current_revision_id: string | null
}

/**
 * A new draft with the post's current content: same brand, texts, settings,
 * figures and images; no times, no approval. Destinations on accounts that
 * left the brand are dropped. Validation is recomputed.
 */
export async function duplicatePost(postId: string): Promise<ActionResult<{ postId: string; dropped: number }>> {
  return runAdminAction<{ postId: string; dropped: number }>('duplicatePost', MESSAGES, async (actor) => {
    if (!isUuid(postId)) return { ok: false, error: 'Postarea nu mai exista.' }
    const db = createAdminClient()
    const { data: postData, error: postError } = await db
      .from('social_posts')
      .select('id, brand_id, kind, title, source_url, current_revision_id')
      .eq('id', postId)
      .maybeSingle()
    if (postError) throw new Error(postError.message)
    const post = postData as SourcePost | null
    if (!post || !post.current_revision_id) return { ok: false, error: 'Postarea nu mai exista.' }

    const [{ data: rev, error: revError }, { data: dests, error: destError }, { data: accounts, error: accError }] = await Promise.all([
      db
        .from('social_post_revisions')
        .select('id, canonical_text, figures, body_markdown, article, launch, card_spec, variants, notes, generator_errors')
        .eq('id', post.current_revision_id)
        .single(),
      db
        .from('social_destinations')
        .select('account_id, text, settings, media:social_destination_media(media_id, position, alt_text, file:social_media(mime, width, height))')
        .eq('revision_id', post.current_revision_id)
        .order('platform'),
      db.from('social_accounts').select('id, platform, rules').eq('brand_id', post.brand_id),
    ])
    if (revError || !rev) throw new Error(revError?.message ?? 'revision missing')
    if (destError) throw new Error(destError.message)
    if (accError) throw new Error(accError.message)

    type DestRow = {
      account_id: string
      text: string
      settings: Record<string, unknown>
      media: Array<{ media_id: string; position: number; alt_text: string; file: { mime: string; width: number; height: number } | null }>
    }
    const brandAccounts = (accounts ?? []) as Array<{ id: string; platform: string; rules: Record<string, unknown> }>
    const inBrand = new Set(brandAccounts.map((a) => a.id))
    const all = (dests ?? []) as unknown as DestRow[]
    const kept = all.filter((d) => inBrand.has(d.account_id))
    if (!kept.length) throw new ActionRefusal('Niciun cont al postarii nu mai apartine brandului; nu am ce copia.')

    const r = rev as Omit<BaseRevision, 'kind' | 'title' | 'destinations'> & { canonical_text: string; figures: EditFigure[] }
    const base: BaseRevision = {
      ...r,
      kind: post.kind,
      title: post.title,
      figures: r.figures ?? [],
      destinations: kept.map((d) => ({
        account_id: d.account_id,
        media: d.media.map((m) => ({ media_id: m.media_id, position: m.position, alt_text: m.alt_text, mime: m.file?.mime, width: m.file?.width, height: m.file?.height })),
      })),
    }
    let rows: ReturnType<typeof buildDraftRevision>
    try {
      rows = buildDraftRevision(
        base,
        {
          title: post.title,
          canonicalText: r.canonical_text ?? '',
          figures: base.figures,
          destinations: kept.map((d) => ({ accountId: d.account_id, text: d.text, settings: d.settings ?? {} })),
        },
        brandAccounts,
        { actorEmail: actor.email, legalNames: legalNamesFromEnv(process.env.SOCIAL_LEGAL_NAMES) }
      )
    } catch (e) {
      if (e instanceof DraftEditError) throw new ActionRefusal(e.message)
      throw e
    }

    const title = `${post.title || 'Postare'} (copie)`.slice(0, 300)
    const newId = await callRpc<string | null>(db, 'social_create_post', {
      p_post: { brand_id: post.brand_id, kind: post.kind, title, source_url: post.source_url, created_by: actor.userId },
      p_revision: rows.revision,
      p_destinations: rows.destinations,
    })
    if (!newId) throw new Error('social_create_post returned nothing')

    // The web sources come along (amendment 07), every one unverified again:
    // a person ticks them for the copy. social_add_post_sources adds them unticked.
    const { data: sourceRows, error: sourceError } = await db
      .from('social_post_sources')
      .select('url, title, publisher, published_at, note, found_in_search')
      .eq('post_id', post.id)
      .order('position', { ascending: true })
    if (sourceError) throw new Error(sourceError.message)
    const sources = (sourceRows ?? []) as Array<Record<string, unknown>>
    if (sources.length) await callRpc<number>(db, 'social_add_post_sources', { p_post: newId, p_sources: sources })

    await logActivity(db, actor, {
      action: 'social.post_duplicated',
      postId: newId,
      details: {
        source_post_id: post.id,
        source_revision_id: post.current_revision_id,
        dropped: all.length - kept.length,
        sources_copied: sources.length,
      },
    })
    revalidatePath('/admin/social')
    revalidatePath('/admin/social/ciorne')
    return { ok: true, postId: newId, dropped: all.length - kept.length }
  })
}
