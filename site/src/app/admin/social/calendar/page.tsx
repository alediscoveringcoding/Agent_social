import type { Metadata } from 'next'
import Link from 'next/link'
import { Badge, Card, PageTitle } from '@/components/ui'
import { requireAdminPage } from '@/lib/auth/admin'
import { getCalendarWeek } from '@/lib/social/calendar-queries'
import { addDays, dayHeading, resolveWeek, timeOfDay, weekLabel } from '@/lib/social/calendar'
import { JOB_STATUS_LABELS, PLATFORM_LABELS } from '@/lib/social/constants'
import { isHttpUrl } from '@/lib/social/schemas'

export const metadata: Metadata = { title: 'Calendar' }
export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ week?: string; cancelled?: string }> }) {
  await requireAdminPage('/admin/social/calendar')
  const query = await searchParams
  const monday = resolveWeek(query.week)
  const cancelled = query.cancelled === '1'
  const week = await getCalendarWeek(monday, { cancelled })
  const href = (day: string) => `/admin/social/calendar?week=${day}${cancelled ? '&cancelled=1' : ''}`
  return <><PageTitle title="Calendar" subtitle={`${weekLabel(monday)} · Europe/Bucharest · ${week.total} destinatii`} actions={<div className="flex gap-3 text-sm font-semibold text-accent-dark"><Link href={href(addDays(monday, -7))}>← Anterior</Link><Link href="/admin/social/calendar">Astazi</Link><Link href={href(addDays(monday, 7))}>Urmator →</Link></div>} />
    <Link className="mb-4 inline-block text-sm text-accent-dark" href={`/admin/social/calendar?week=${monday}${cancelled ? '' : '&cancelled=1'}`}>{cancelled ? 'Ascunde anulatele' : 'Arata si anulatele'}</Link>
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">{week.days.map((day) => {
      const heading = dayHeading(day.day)
      return <Card key={day.day} className="min-w-0 p-3"><h2 className="font-bold">{heading.weekday}</h2><p className="mb-3 text-xs text-ink-soft">{heading.date}{day.hours !== 24 ? ` · ${day.hours} ore (schimbarea orei)` : ''}</p>
        {!day.entries.length && <p className="text-xs text-ink-soft">Nicio destinatie.</p>}
        <ul className="space-y-3">{day.entries.map((e) => <li key={e.key} className="space-y-1 border-t border-line pt-2 text-xs"><p className="font-bold">{timeOfDay(e.at)} · {PLATFORM_LABELS[e.platform]}</p>
          {e.post_id && <Link className="block break-words font-semibold text-accent-dark hover:underline" href={`/admin/social/${e.kind === 'draft' ? 'ciorne' : 'postari'}/${e.post_id}`}>{e.title || '(fara titlu)'}</Link>}
          <p className="break-words text-ink-soft">{e.brand} · {e.account}</p><Badge tone={e.status === 'failed' ? 'danger' : e.status === 'published' || e.status === 'manual_done' ? 'accent' : 'neutral'}>{e.status === 'draft' ? 'Ciorna' : JOB_STATUS_LABELS[e.status]}</Badge>
          {e.status === 'manual_pending' && <Link className="block text-accent-dark" href={`/admin/social/manual/${e.job_id}`}>Publica manual</Link>}
          {e.remote_url && isHttpUrl(e.remote_url) && <a href={e.remote_url} target="_blank" rel="noreferrer" className="block text-accent-dark">Vezi publicarea ↗</a>}{e.error_code && <p className="text-danger">{e.error_code}</p>}</li>)}</ul></Card>
    })}</div></>
}
