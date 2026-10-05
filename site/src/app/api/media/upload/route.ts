import { createAdminClient } from '@/lib/supabase/admin'
import { isLocalMode } from '@/lib/local/mode'
import { SOCIAL_BUCKET } from '@/lib/social/constants'
import { verifyUploadTicket } from '@/lib/social/media/signing'
import { readUploadBody, ingestImage } from '@/lib/social/media/ingest'

export const runtime = 'nodejs'
export async function POST(request: Request) {
  if (!isLocalMode()) return new Response('Not found', { status: 404 })
  const ticket = verifyUploadTicket(new URL(request.url).searchParams.get('ticket') ?? '')
  if (!ticket) return new Response('Forbidden', { status: 403 })
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== ticket.mime) return new Response('Invalid file type', { status: 415 })
  try {
    const image = await ingestImage(await readUploadBody(request), ticket.mime)
    const db = createAdminClient()
    const take = await db.rpc('social_take_upload_ticket', { p_path: ticket.path, p_user: ticket.userId, p_mime: ticket.mime, p_phase: 'issued', p_next: 'uploaded' })
    if (take.error || !take.data) return new Response('Ticket already used', { status: 403 })
    const result = await db.storage.from(SOCIAL_BUCKET).upload(ticket.path, image.bytes, { contentType: image.mime, upsert: false })
    if (result.error) return new Response('Storage failed', { status: 500 })
    return Response.json({ ok: true })
  } catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'Invalid image' }, { status: 400 }) }
}
