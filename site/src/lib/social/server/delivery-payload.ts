import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SOCIAL_BUCKET } from '../constants.ts'
import { toHashTimestamp } from '../hash.ts'

/** What `social_claim_deliveries` hands back for each leased job. */
export interface ClaimedJob {
  job_id: string
  kind: 'publish' | 'poll' | 'reconcile'
  attempt_no: number
  lease_expires_at: string
}

/** PRD 10.3 `DeliveryJob`. */
export interface DeliveryJob {
  job_id: string
  kind: ClaimedJob['kind']
  attempt_no: number
  lease_expires_at: string
  run_at: string
  account: { id: string; platform: string; postiz_integration_id: string | null }
  destination: {
    id: string
    text: string
    settings: Record<string, unknown>
    scheduled_at: string
    destination_hash: string | null
  }
  media: Array<{ media_id: string; url: string | null; mime: string; sha256: string; alt_text: string }>
  postiz: { post_id: string; group: string | null } | null
  attempt_started_at: string | null
}

/** Signed media URLs live one hour (PRD 13, security). */
export const MEDIA_URL_TTL_SECONDS = 3600

interface JobRow {
  id: string
  run_at: string
  destination_id: string
  account_id: string
  postiz_post_id: string | null
  postiz_group: string | null
}
interface DestinationRow {
  id: string
  text: string
  settings: Record<string, unknown> | null
  scheduled_at: string
  destination_hash: string | null
}
interface AccountRow {
  id: string
  platform: string
  postiz_integration_id: string | null
}
interface MediaLinkRow {
  destination_id: string
  position: number
  alt_text: string
  media: { id: string; storage_path: string; mime: string; sha256: string } | null
}
interface AttemptRow {
  job_id: string
  attempt_no: number
  started_at: string
  submitting_at: string | null
}

/** PostgREST embeds a many-to-one relation as an object; the untyped client calls it an array. */
function must<T>(res: { data: unknown; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`)
  return (res.data ?? ([] as unknown)) as T
}

export async function buildDeliveryJobs(admin: SupabaseClient, claimed: ReadonlyArray<ClaimedJob>): Promise<DeliveryJob[]> {
  if (claimed.length === 0) return []
  const jobIds = claimed.map((c) => c.job_id)

  const jobs = must<JobRow[]>(
    await admin
      .from('social_delivery_jobs')
      .select('id, run_at, destination_id, account_id, postiz_post_id, postiz_group')
      .in('id', jobIds),
    'jobs'
  )
  const destinationIds = jobs.map((j) => j.destination_id)
  const accountIds = [...new Set(jobs.map((j) => j.account_id))]

  const [destinations, accounts, links, attempts] = await Promise.all([
    admin
      .from('social_destinations')
      .select('id, text, settings, scheduled_at, destination_hash')
      .in('id', destinationIds)
      .then((r) => must<DestinationRow[]>(r, 'destinations')),
    admin
      .from('social_accounts')
      .select('id, platform, postiz_integration_id')
      .in('id', accountIds)
      .then((r) => must<AccountRow[]>(r, 'accounts')),
    admin
      .from('social_destination_media')
      .select('destination_id, position, alt_text, media:social_media(id, storage_path, mime, sha256)')
      .in('destination_id', destinationIds)
      .order('position', { ascending: true })
      .then((r) => must<MediaLinkRow[]>(r, 'media')),
    admin
      .from('social_publish_attempts')
      .select('job_id, attempt_no, started_at, submitting_at')
      .in('job_id', jobIds)
      .then((r) => must<AttemptRow[]>(r, 'attempts')),
  ])

  const paths = [...new Set(links.map((l) => l.media?.storage_path).filter((p): p is string => !!p))]
  const signed = new Map<string, string>()
  if (paths.length) {
    const { data, error } = await admin.storage.from(SOCIAL_BUCKET).createSignedUrls(paths, MEDIA_URL_TTL_SECONDS)
    if (error) {
      // The worker reports MEDIA_FETCH_FAILED and gets a fresh claim; better
      // than holding every claimed job hostage to one Storage hiccup.
      console.error('[social/worker] could not sign media URLs:', error.message)
    }
    for (const s of data ?? []) {
      if (s.path && s.signedUrl && !s.error) signed.set(s.path, s.signedUrl)
    }
  }

  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]))
  const jobMap = byId(jobs)
  const destMap = byId(destinations)
  const accMap = byId(accounts)

  const out: DeliveryJob[] = []
  for (const c of claimed) {
    const job = jobMap.get(c.job_id)
    if (!job) continue
    const dest = destMap.get(job.destination_id)
    const acc = accMap.get(job.account_id)
    if (!dest || !acc) continue
    const attempt = attempts.find((a) => a.job_id === job.id && a.attempt_no === c.attempt_no)
    const media = links
      .filter((l) => l.destination_id === dest.id && l.media)
      .sort((a, b) => a.position - b.position)
      .map((l) => ({
        media_id: l.media!.id,
        url: signed.get(l.media!.storage_path) ?? null,
        mime: l.media!.mime,
        sha256: l.media!.sha256,
        alt_text: l.alt_text,
      }))

    out.push({
      job_id: job.id,
      kind: c.kind,
      attempt_no: c.attempt_no,
      lease_expires_at: toHashTimestamp(c.lease_expires_at),
      run_at: toHashTimestamp(job.run_at),
      account: { id: acc.id, platform: acc.platform, postiz_integration_id: acc.postiz_integration_id },
      destination: {
        id: dest.id,
        text: dest.text,
        settings: dest.settings ?? {},
        scheduled_at: toHashTimestamp(dest.scheduled_at),
        destination_hash: dest.destination_hash,
      },
      media,
      postiz: c.kind !== 'publish' && job.postiz_post_id ? { post_id: job.postiz_post_id, group: job.postiz_group } : null,
      attempt_started_at:
        c.kind !== 'publish' && attempt ? toHashTimestamp(attempt.submitting_at ?? attempt.started_at) : null,
    })
  }
  return out
}
