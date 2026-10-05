import { createAdminClient } from '@/lib/supabase/admin'
import { SOCIAL_BUCKET } from '@/lib/social/constants'
import { verifyMediaSignature } from '@/lib/social/media/signing'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const query = new URL(request.url).searchParams
  const exp = query.get('exp') ?? ''
  if (!/^\d+$/.test(exp) || !verifyMediaSignature(id, Number(exp), query.get('sig') ?? '')) return new Response('Forbidden', { status: 403 })
  const db = createAdminClient()
  const { data, error } = await db.from('social_media').select('storage_path, mime').eq('id', id).maybeSingle()
  if (error || !data) return new Response('Not found', { status: 404 })
  const row = data as { storage_path: string; mime: string }
  const file = await db.storage.from(SOCIAL_BUCKET).download(row.storage_path)
  if (file.error || !file.data) return new Response('Not found', { status: 404 })
  return new Response(file.data, { headers: { 'Content-Type': row.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } })
}
