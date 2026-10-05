import { z } from 'zod'
import { requireAdmin } from '@/lib/auth/admin'
import { CARD_FORMATS, type CardFormat } from '@/lib/social/constants'
import { normalizeCardSpec, checkCardSpec } from '@/lib/social/cards/spec'
import { cardBrand } from '@/lib/social/cards/palette'
import { renderCardPng } from '@/lib/social/cards/render'
import { loadMediaRevision } from '@/lib/social/media/revision'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET(request: Request) {
  try { await requireAdmin() } catch { return new Response('Forbidden', { status: 403 }) }
  try {
    const q = new URL(request.url).searchParams
    const postId = z.uuid().parse(q.get('postId')); const revisionId = z.uuid().parse(q.get('revisionId'))
    const ctx = await loadMediaRevision(postId, revisionId)
    const format = q.get('format') as CardFormat
    if (!Object.hasOwn(CARD_FORMATS, format)) return new Response('Invalid format', { status: 400 })
    if (!['light','dark','mint'].includes(q.get('template') ?? '')) return new Response('Invalid template', { status: 400 })
    const spec = normalizeCardSpec({ brand: ctx.post.brand.slug, template: q.get('template') as 'light' | 'dark' | 'mint', headline: q.get('headline') ?? '', keyword: q.get('keyword'), stat: q.get('stat'), subline: q.get('subline') })
    if (checkCardSpec(spec).length) return new Response('Invalid card', { status: 400 })
    const image = await renderCardPng(spec, format, cardBrand(ctx.post.brand.slug, ctx.post.brand.name))
    return new Response(new Uint8Array(image.bytes), { headers: { 'Content-Type': image.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
  } catch { return new Response('Invalid preview', { status: 400 }) }
}
