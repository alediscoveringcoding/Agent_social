'use server'

import { randomUUID, createHash } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAdmin, type AdminIdentity } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/admin'
import { isLocalMode } from '@/lib/local/mode'
import { SOCIAL_BUCKET, PLATFORM_CARD_FORMAT, type Platform } from './constants.ts'
import { logActivity } from './server/activity.ts'
import { signUploadTicket, verifyUploadTicket, UPLOAD_TTL } from './media/signing.ts'
import { ingestImage, MAX_UPLOAD_BYTES } from './media/ingest.ts'
import { loadMediaRevision, saveMediaRevision } from './media/revision.ts'
import { cardBrand } from './cards/palette.ts'
import { normalizeCardSpec, checkCardSpec, type CardSpec } from './cards/spec.ts'
import { renderCardPng } from './cards/render.ts'
import { cardCopyIssues } from './cards/copy.ts'
import { legalNamesFromEnv } from './content-rules.ts'
import type { BaseRevision } from './draft-edit.ts'
import type { ActionResult } from './actions.ts'

const idSchema = z.uuid()
const altSchema = z.string().trim().min(1, 'Scrie textul alternativ.').max(1000)
const cardSchema = z.object({ template: z.enum(['light', 'dark', 'mint']), headline: z.string().max(70), keyword: z.string().max(70).nullable().optional(), stat: z.string().max(8).nullable().optional(), subline: z.string().max(110).nullable().optional(), alt_text: altSchema, brand: z.string().optional() })
async function guarded<T extends object>(action: string, body: (actor: AdminIdentity) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const actor = await requireAdmin()
    const result = await body(actor)
    // Signed upload URLs/tokens are bearer credentials: never put them in logs.
    const details = Object.fromEntries(Object.entries(result).filter(([key]) => ['postId', 'revisionId', 'mediaId', 'mediaIds'].includes(key)))
    await logActivity(createAdminClient(), actor, { action: `social.${action}`, details })
    revalidatePath('/admin/social/media')
    revalidatePath('/admin/social/ciorne', 'layout')
    return { ok: true, ...result }
  } catch (e) {
    if (e instanceof z.ZodError) return { ok: false, error: e.issues[0]?.message ?? 'Date invalide.' }
    return { ok: false, error: e instanceof Error ? e.message : 'Ceva nu a mers.' }
  }
}
export async function createUploadTicket(input: { mime: string; bytes: number }) {
  return guarded('media_ticket_created', async (actor) => {
    const parsed = z.object({ mime: z.enum(['image/jpeg', 'image/png', 'image/webp']), bytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES) }).parse(input)
    const path = `staging/${randomUUID()}`
    const exp = Math.floor(Date.now() / 1000) + UPLOAD_TTL
    const db = createAdminClient()
    // Bound abandoned staging objects and consumed ticket retention. A token
    // cannot be replayed once expired, even after its ticket row is removed.
    const expired = await db.from('social_upload_tickets').select('path').lt('expires_at', new Date().toISOString()).limit(100)
    const expiredPaths = ((expired.data ?? []) as Array<{ path: string }>).map((t) => t.path)
    if (expiredPaths.length) {
      const removed = await db.storage.from(SOCIAL_BUCKET).remove(expiredPaths)
      if (!removed.error) await db.from('social_upload_tickets').delete().in('path', expiredPaths)
    }
    const { error } = await db.from('social_upload_tickets').insert({ path, user_id: actor.userId, mime: parsed.mime, expires_at: new Date(exp * 1000).toISOString() })
    if (error) throw new Error('Nu am putut pregati incarcarea.')
    const ticket = signUploadTicket({ path, mime: parsed.mime, exp, userId: actor.userId })
    if (isLocalMode()) return { ticket, url: `/api/media/upload?ticket=${encodeURIComponent(ticket)}`, method: 'POST' as const }
    const signed = await db.storage.from(SOCIAL_BUCKET).createSignedUploadUrl(path)
    if (signed.error || !signed.data) throw new Error('Nu am putut pregati incarcarea in Storage.')
    return { ticket, url: signed.data.signedUrl, method: 'PUT' as const }
  })
}
export async function finalizeUpload(input: { ticket: string; altText: string }) {
  return guarded('media_uploaded', async (actor) => {
    const altText = altSchema.parse(input.altText)
    const ticket = verifyUploadTicket(input.ticket)
    if (!ticket || ticket.userId !== actor.userId) throw new Error('Incarcarea a expirat sau nu iti apartine.')
    const db = createAdminClient()
    const take = await db.rpc('social_take_upload_ticket', { p_path: ticket.path, p_user: actor.userId, p_mime: ticket.mime, p_phase: isLocalMode() ? 'uploaded' : 'issued', p_next: 'consumed' })
    if (take.error || !take.data) throw new Error('Incarcarea a fost deja folosita sau a expirat.')
    const bucket = db.storage.from(SOCIAL_BUCKET)
    let finalPath: string | undefined
    let saved = false
    try {
      const download = await bucket.download(ticket.path)
      if (download.error || !download.data) throw new Error('Fisierul incarcat nu exista.')
      if (download.data.size > MAX_UPLOAD_BYTES) throw new Error('Imaginea depaseste 8 MB.')
      const image = await ingestImage(new Uint8Array(await download.data.arrayBuffer()), ticket.mime)
      const id = ticket.path.slice(8)
      finalPath = `uploads/${id}.${image.ext}`
      const stored = await bucket.upload(finalPath, image.bytes, { contentType: image.mime, upsert: false })
      if (stored.error) throw new Error('Nu am putut salva imaginea.')
      const { error } = await db.from('social_media').insert({ id, source: 'upload', storage_path: finalPath, mime: image.mime, width: image.width, height: image.height, bytes: image.bytes.length, sha256: image.sha256, alt_text: altText, created_by: actor.userId })
      if (error) throw new Error('Nu am putut salva detaliile imaginii.')
      saved = true
      return { mediaId: id }
    } finally {
      await bucket.remove([ticket.path])
      if (!saved && finalPath) await bucket.remove([finalPath])
    }
  })
}
export async function setDestinationMedia(input: { postId: string; baseRevisionId: string; accountId: string; media: Array<{ mediaId: string; altText?: string }> }) {
  return guarded('destination_media_saved', async (actor) => {
    const parsed = z.object({ postId: idSchema, baseRevisionId: idSchema, accountId: idSchema, media: z.array(z.object({ mediaId: idSchema, altText: altSchema.optional() })).max(10) }).parse(input)
    if (new Set(parsed.media.map((m) => m.mediaId)).size !== parsed.media.length) throw new Error('O imagine apare de doua ori.')
    const ctx = await loadMediaRevision(parsed.postId, parsed.baseRevisionId)
    const ids = parsed.media.map((m) => m.mediaId)
    const files = ids.length ? await ctx.db.from('social_media').select('id, mime, width, height, alt_text, brand_id').in('id', ids) : { data: [], error: null }
    if (files.error) throw new Error(files.error.message)
    const rows = (files.data ?? []) as Array<{ id: string; mime: string; width: number; height: number; alt_text: string; brand_id: string | null }>
    const replacement = parsed.media.map((m, position) => {
      const file = rows.find((f) => f.id === m.mediaId)
      if (!file || (file.brand_id && file.brand_id !== ctx.post.brand_id)) throw new Error('Imaginea nu exista sau apartine altui brand.')
      return { media_id: file.id, position, alt_text: altSchema.parse(m.altText ?? file.alt_text), mime: file.mime, width: file.width, height: file.height }
    })
    const revisionId = await saveMediaRevision(ctx, parsed.baseRevisionId, actor, new Map([[parsed.accountId, replacement]]))
    return { postId: parsed.postId, revisionId }
  })
}
export async function generateCards(input: { postId: string; baseRevisionId: string; spec: Partial<CardSpec>; accountIds?: string[] }) {
  return guarded('cards_generated', async (actor) => {
    idSchema.parse(input.postId); idSchema.parse(input.baseRevisionId)
    const ctx = await loadMediaRevision(input.postId, input.baseRevisionId)
    const spec = normalizeCardSpec({ ...cardSchema.parse(input.spec), brand: ctx.post.brand.slug })
    const issues = checkCardSpec(spec, { requireAlt: true })
    if (issues.length) throw new Error(issues[0]!.message)
    const copyIssues = cardCopyIssues(spec, legalNamesFromEnv(process.env.SOCIAL_LEGAL_NAMES))
    if (copyIssues.length) throw new Error(copyIssues[0])
    const ids = input.accountIds === undefined ? ctx.destinations.map((d) => d.account_id) : z.array(idSchema).min(1).max(8).parse(input.accountIds)
    if (new Set(ids).size !== ids.length || ids.some((id) => !ctx.destinations.some((d) => d.account_id === id))) throw new Error('Alege destinatiile din revizia curenta.')
    const replacements = new Map<string, BaseRevision['destinations'][number]['media']>()
    const created: Array<{ id: string; path: string }> = []
    const bucket = ctx.db.storage.from(SOCIAL_BUCKET)
    try {
      for (const accountId of ids) {
        const account = ctx.accounts.find((a) => a.id === accountId)!
        const format = PLATFORM_CARD_FORMAT[account.platform as Platform]
        if (!format) throw new Error('Platforma nu are format de card.')
        const image = await renderCardPng(spec, format, cardBrand(ctx.post.brand.slug, ctx.post.brand.name))
        const id = randomUUID(); const path = `generated/${id}.png`
        const stored = await bucket.upload(path, image.bytes, { contentType: image.mime, upsert: false })
        if (stored.error) throw new Error('Nu am putut salva cardul.')
        created.push({ id, path })
        const { error } = await ctx.db.from('social_media').insert({ id, source: 'generated', storage_path: path, mime: image.mime, width: image.width, height: image.height, bytes: image.bytes.length, sha256: createHash('sha256').update(image.bytes).digest('hex'), alt_text: spec.alt_text, card_spec: spec, format, brand_id: ctx.post.brand_id, created_by: actor.userId })
        if (error) throw new Error(error.message)
        replacements.set(accountId, [{ media_id: id, position: 0, alt_text: spec.alt_text!, mime: image.mime, width: image.width, height: image.height }])
      }
      const revisionId = await saveMediaRevision(ctx, input.baseRevisionId, actor, replacements, spec)
      return { postId: input.postId, revisionId, mediaIds: created.map((m) => m.id) }
    } catch (e) {
      // If a competing save won, no generated media is left detached by this action.
      for (const item of created) {
        const deleted = await ctx.db.from('social_media').delete().eq('id', item.id)
        if (!deleted.error) await bucket.remove([item.path])
      }
      throw e
    }
  })
}
export async function updateMediaAlt(input: { mediaId: string; altText: string }) {
  return guarded('media_alt_updated', async () => {
    const id = idSchema.parse(input.mediaId); const alt = altSchema.parse(input.altText)
    // Library text is a suggestion. Existing attachment copies remain frozen.
    const { data, error } = await createAdminClient().from('social_media').update({ alt_text: alt }).eq('id', id).select('id').single()
    if (error || !data) throw new Error('Imaginea nu exista.')
    return { mediaId: id }
  })
}
export async function deleteMedia(mediaId: string) {
  return guarded('media_deleted', async () => {
    const id = idSchema.parse(mediaId); const db = createAdminClient()
    const row = await db.from('social_media').select('storage_path').eq('id', id).single()
    if (row.error || !row.data) throw new Error('Imaginea nu exista.')
    // FK RESTRICT is the atomic attachment check, including historical revisions.
    const deleted = await db.from('social_media').delete().eq('id', id)
    if (deleted.error) throw new Error('Imaginea este atasata unei revizii si nu poate fi stearsa.')
    const removed = await db.storage.from(SOCIAL_BUCKET).remove([(row.data as { storage_path: string }).storage_path])
    if (removed.error) console.error('[social/media] orphan object cleanup failed:', removed.error.message)
    return { mediaId: id }
  })
}
