import type { Metadata } from 'next'
import Link from 'next/link'
import { Card, Empty, PageTitle } from '@/components/ui'
import { requireAdminPage } from '@/lib/auth/admin'
import { listAutomationRuns } from '@/lib/social/automation-queries'
import { getOverview } from '@/lib/social/overview-queries'
import { ACCOUNT_STATUS_LABELS } from '@/lib/social/constants'
import { AutomationCard } from './AutomationCard'
import { EventFeed } from './EventFeed'
import { JobList } from './JobList'
import { WorkerHealth } from './WorkerHealth'

export const metadata: Metadata = { title: 'Prezentare' }
export default async function SocialHome({ searchParams }: { searchParams: Promise<{ seen?: string }> }) {
  await requireAdminPage('/admin/social')
  const [data, automationRuns] = await Promise.all([
    getOverview({ includeSeen: (await searchParams).seen === '1' }),
    // A side widget: if n8n's runs cannot be read, the rest of the overview still opens.
    listAutomationRuns(10).catch((e: unknown) => {
      console.error('[social/overview] automation runs failed:', e)
      return null
    }),
  ])
  return <><PageTitle title="Prezentare" subtitle="Ciorne, publicari si conturi care au nevoie de tine." actions={<Link className="font-semibold text-accent-dark" href="/admin/social/genereaza">Genereaza ciorne</Link>} />
    <div className="space-y-5"><WorkerHealth health={data.worker} now={data.now} />
    <div className="grid gap-5 lg:grid-cols-2"><Card><h2 className="mb-3 font-bold">De aprobat ({data.approvalQueue.length})</h2>{!data.approvalQueue.length ? <Empty title="Nicio ciorna." /> : <ul className="space-y-2">{data.approvalQueue.map((d) => <li key={d.id}><Link href={`/admin/social/ciorne/${d.id}`} className="font-semibold text-accent-dark hover:underline">{d.title || '(fara titlu)'}</Link><p className="text-xs text-ink-soft">{d.brand?.name} · {d.destinations.length} destinatii · {d.unverified_figures} cifre neverificate</p></li>)}</ul>}</Card>
    <Card><h2 className="mb-3 font-bold">Conturi de verificat</h2><p className="mb-2 text-sm">{data.unassigned} conturi asteapta un brand. <Link href="/admin/social/conturi" className="text-accent-dark">Gestioneaza conturile</Link></p><ul className="space-y-2 text-sm">{data.attention.map((a) => <li key={a.id}>{a.display_name} · {ACCOUNT_STATUS_LABELS[a.status]}{a.postiz_disabled ? ' · dezactivat in Postiz' : ''}</li>)}</ul></Card>
    <Card><h2 className="mb-3 font-bold">Astazi ({data.today.length})</h2><JobList jobs={data.today} /></Card>
    <Card><h2 className="mb-3 font-bold">Urmatoarele 7 zile ({data.upcoming.length})</h2><JobList jobs={data.upcoming} /></Card>
    <Card><h2 className="mb-3 font-bold">Publicari esuate ({data.failures.length})</h2><JobList jobs={data.failures} /></Card>
    <Card><h2 className="mb-3 font-bold"><Link href="/admin/social/manual" className="text-accent-dark">De publicat manual ({data.manualDue.length})</Link></h2><JobList jobs={data.manualDue} manual /></Card></div>
    <AutomationCard runs={automationRuns} />
    <EventFeed events={data.events} unseen={data.unseen} /></div></>
}
