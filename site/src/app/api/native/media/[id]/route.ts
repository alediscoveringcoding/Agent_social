import sharp from 'sharp'
import { createAdminClient } from '@/lib/supabase/admin'
import { SOCIAL_BUCKET } from '@/lib/social/constants'
import { verifyMediaSignature } from '@/lib/social/media/signing'
import { sha256OfBytes } from '@/lib/social/hash'

export const runtime = 'nodejs'
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const query = new URL(request.url).searchParams
  const exp = query.get('exp') || ''
  if (!/^\d+$/.test(exp) || !verifyMediaSignature(id, Number(exp), query.get('sig') || '')) return new Response('Forbidden', { status: 403 })
  const admin = createAdminClient()
  const { data, error } = await admin.from('social_media').select('storage_path,mime,sha256').eq('id', id).maybeSingle()
  if (error || !data || !['image/png', 'image/jpeg', 'image/webp'].includes(data.mime)) return new Response('Not found', { status: 404 })
  const file = await admin.storage.from(SOCIAL_BUCKET).download(data.storage_path)
  if (file.error || !file.data) return new Response('Not found', { status: 404 })
  const original = new Uint8Array(await file.data.arrayBuffer())
  if (sha256OfBytes(original) !== data.sha256) return new Response('Media mismatch', { status: 409 })
  // Deterministic transport conversion: source bytes, attachment copy and its
  // approval hash remain frozen. No resize, crop or content repainting occurs.
  const jpeg = await sharp(original, { limitInputPixels: 40_000_000 }).flatten({ background: '#ffffff' }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer()
  return new Response(new Uint8Array(jpeg), { headers: { 'Content-Type': 'image/jpeg', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private,no-store', 'Referrer-Policy': 'no-referrer' } })
}
