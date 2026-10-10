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
  const db = createAdminClient()
  let claimed = false
  try {
    const body = await readUploadBody(request)
    // Claim the ticket before the expensive decode: one ticket, one decode.
    const take = await db.rpc('social_take_upload_ticket', { p_path: ticket.path, p_user: ticket.userId, p_mime: ticket.mime, p_phase: 'issued', p_next: 'uploaded' })
    if (take.error || !take.data) return new Response('Ticket already used', { status: 403 })
    claimed = true
    const image = await ingestImage(body, ticket.mime)
    const result = await db.storage.from(SOCIAL_BUCKET).upload(ticket.path, image.bytes, { contentType: image.mime, upsert: false })
    if (result.error) throw new Error('Storage failed')
    return Response.json({ ok: true })
  } catch (e) {
    // The state machine (migration 0004) has no way back from 'uploaded', so a failed ticket is dropped: ask for a new one.
    if (claimed) await db.from('social_upload_tickets').delete().eq('path', ticket.path).then(() => undefined, () => undefined)
    return Response.json({ error: e instanceof Error ? e.message : 'Invalid image' }, { status: 400 })
  }
}
