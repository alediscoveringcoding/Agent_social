import Link from 'next/link'
import { Badge, Empty } from '@/components/ui'
import { JOB_STATUS_LABELS, PLATFORM_LABELS } from '@/lib/social/constants'
import type { JobView } from '@/lib/social/jobs-view'
import { isHttpUrl } from '@/lib/social/schemas'
import { formatBucharest } from '@/lib/social/time'

export function JobList({ jobs, manual = false }: { jobs: JobView[]; manual?: boolean }) {
  if (!jobs.length) return <Empty title="Nicio destinatie." />
  return <ul className="space-y-2">{jobs.map((j) => <li key={j.id} className="rounded-lg border border-line bg-card p-3">
    <Link className="font-bold text-accent-dark hover:underline" href={manual ? `/admin/social/manual/${j.id}` : `/admin/social/postari/${j.post?.id ?? ''}`}>{j.post?.title || '(fara titlu)'}</Link>
    <p className="mt-1 text-xs text-ink-soft">{j.post?.brand?.name ?? '-'} · {PLATFORM_LABELS[j.platform]} · {j.account?.display_name} · {formatBucharest(j.run_at)}</p>
    <div className="mt-2 flex flex-wrap items-center gap-2"><Badge tone={j.status === 'failed' ? 'danger' : j.status === 'published' || j.status === 'manual_done' ? 'accent' : 'neutral'}>{JOB_STATUS_LABELS[j.status]}</Badge>
      {j.remote_url && isHttpUrl(j.remote_url) && <a className="text-sm font-semibold text-accent-dark hover:underline" href={j.remote_url} target="_blank" rel="noreferrer">Vezi publicarea</a>}
      {j.last_error_code && <span className="text-xs text-danger">{j.last_error_code}: {j.last_error_message}</span>}</div>
  </li>)}</ul>
}
