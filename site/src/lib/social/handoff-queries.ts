import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { DEFAULT_OPEN_EDITOR_URLS, SOCIAL_BUCKET, type Platform, type PostKind } from './constants.ts'
import { buildHandoff, downloadName, type Handoff } from './handoff.ts'
import { getJobView, listJobViews, type JobView } from './jobs-view.ts'

/**
 * Reads for the manual handoff (PRD flow 6.2, F8): the list of destinations
 * a person publishes by hand, and everything one of them needs.
 */

export interface HandoffMedia {
  media_id: string
  position: number
  alt_text: string
  mime: string
  width: number
  height: number
  url: string | null
  filename: string
}

export interface ManualJobDetail {
  job: JobView
  text: string
  settings: Record<string, unknown>
  media: HandoffMedia[]
  account: {
    id: string
    display_name: string
    platform: Platform
    mode: 'auto' | 'manual'
    open_editor_url: string | null
    profile_url: string | null
  }
  revision: { id: string; number: number; kind: PostKind }
  handoff: Handoff
  /** The slot has come (or passed). */
  due: boolean
  manual_done_by_email: string | null
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

function must<T>(res: { data: unknown; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return res.data as T
}

/**
 * Short-lived links for the images. Same source as the draft editor's
 * previews (Storage signed URLs); in local mode they follow whatever the
 * local storage gives (W2 owns that path).
 */
async function signMediaUrls(paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!paths.length) return out
  const admin = createAdminClient()
  const { data } = await admin.storage.from(SOCIAL_BUCKET).createSignedUrls([...new Set(paths)], 3600)
  for (const s of data ?? []) if (s.path && s.signedUrl) out.set(s.path, s.signedUrl)
  return out
}

export async function listManualJobs(limitDone = 20): Promise<{ pending: JobView[]; done: JobView[] }> {
  const [pending, done] = await Promise.all([
    listJobViews({ statuses: ['manual_pending'], limit: 200 }),
    listJobViews({ statuses: ['manual_done'], ascending: false, limit: limitDone }),
  ])
  return { pending, done }
}

interface DestinationRow {
  id: string
  text: string
  settings: Record<string, unknown> | null
  account: {
    id: string
    display_name: string
    platform: Platform
    mode: 'auto' | 'manual'
    open_editor_url: string | null
    profile_url: string | null
  } | null
  revision: { id: string; number: number; article: Record<string, unknown> | null; launch: Record<string, unknown> | null } | null
  media: Array<{
    media_id: string
    position: number
    alt_text: string
    file: { mime: string; width: number; height: number; storage_path: string } | null
  }>
}

export async function getManualJob(jobId: string, now: Date = new Date()): Promise<ManualJobDetail | null> {
  const job = await getJobView(jobId)
  if (!job || !job.post || !job.destination_id) return null
  const admin = createAdminClient()
  const [dest, doneBy] = await Promise.all([
    admin
      .from('social_destinations')
      .select(
        'id, text, settings, account:social_accounts(id, display_name, platform, mode, open_editor_url, profile_url), revision:social_post_revisions(id, number, article, launch), media:social_destination_media(media_id, position, alt_text, file:social_media(mime, width, height, storage_path))'
      )
      .eq('id', job.destination_id)
      .single()
      .then((r) => must<DestinationRow>(r, 'destination')),
    admin
      .from('social_delivery_jobs')
      .select('manual_done_by')
      .eq('id', jobId)
      .single()
      .then(async (r) => {
        const by = (must<{ manual_done_by: string | null }>(r, 'job') ?? { manual_done_by: null }).manual_done_by
        if (!by) return null
        const log = must<Array<{ actor_email: string | null }>>(
          await admin.from('social_activity_log').select('actor_email').eq('actor_id', by).limit(1),
          'actor'
        )
        return log?.[0]?.actor_email ?? null
      }),
  ])
  if (!dest.account || !dest.revision) return null

  const media = (dest.media ?? []).filter((m) => m.file).sort((a, b) => a.position - b.position)
  const signed = await signMediaUrls(media.map((m) => m.file!.storage_path))
  const settings = dest.settings ?? {}
  const handoff = buildHandoff({
    platform: job.platform,
    kind: job.post.kind,
    title: job.post.title,
    text: dest.text ?? '',
    settings,
    article: dest.revision.article,
    launch: dest.revision.launch,
  })

  return {
    job,
    text: dest.text ?? '',
    settings,
    media: media.map((m, i) => ({
      media_id: m.media_id,
      position: m.position,
      alt_text: m.alt_text,
      mime: m.file!.mime,
      width: m.file!.width,
      height: m.file!.height,
      url: signed.get(m.file!.storage_path) ?? null,
      filename: downloadName(job.post!.title, job.platform, 'txt').replace(/\.txt$/, `-${i + 1}.${EXT[m.file!.mime] ?? 'img'}`),
    })),
    account: {
      ...dest.account,
      open_editor_url: dest.account.open_editor_url || DEFAULT_OPEN_EDITOR_URLS[dest.account.platform] || null,
    },
    revision: { id: dest.revision.id, number: dest.revision.number, kind: job.post.kind },
    handoff,
    due: new Date(job.run_at).getTime() <= now.getTime(),
    manual_done_by_email: doneBy,
  }
}
