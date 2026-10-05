import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { SOCIAL_BUCKET } from './constants.ts'

export interface MediaItem {
  id: string; source: 'upload' | 'generated'; mime: string; width: number; height: number; bytes: number
  alt_text: string; format: string | null; brand_id: string | null; created_at: string; url: string | null; attached: boolean
}
export async function listMedia(brandId?: string): Promise<MediaItem[]> {
  const db = createAdminClient()
  const res = await db.from('social_media').select('id, source, storage_path, mime, width, height, bytes, alt_text, format, brand_id, created_at').order('created_at', { ascending: false }).limit(200)
  if (res.error) throw new Error(res.error.message)
  const items = ((res.data ?? []) as Array<Omit<MediaItem, 'url' | 'attached'> & { storage_path: string }>).filter((m) => !brandId || !m.brand_id || m.brand_id === brandId)
  if (!items.length) return []
  const links = await db.from('social_destination_media').select('media_id').in('media_id', items.map((m) => m.id))
  if (links.error) throw new Error(links.error.message)
  const used = new Set(((links.data ?? []) as Array<{ media_id: string }>).map((m) => m.media_id))
  const signed = await db.storage.from(SOCIAL_BUCKET).createSignedUrls(items.map((m) => m.storage_path), 3600)
  const urls = new Map((signed.data ?? []).filter((s) => !s.error).map((s) => [s.path, s.signedUrl]))
  return items.map(({ storage_path, ...item }) => ({ ...item, attached: used.has(item.id), url: urls.get(storage_path) ?? null }))
}
