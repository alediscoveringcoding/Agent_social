import type { Metadata } from 'next'
import { Card, PageTitle } from '@/components/ui'
import { requireAdminPage } from '@/lib/auth/admin'
import { listManualJobs } from '@/lib/social/handoff-queries'
import { JobList } from '../JobList'

export const metadata: Metadata = { title: 'Publicare manuala' }
export default async function ManualPage() {
  await requireAdminPage('/admin/social/manual')
  const jobs = await listManualJobs()
  return <><PageTitle title="Publicare manuala" subtitle="Copiaza continutul in editorul platformei, publica si salveaza linkul public." /><div className="space-y-5"><Card><h2 className="mb-3 font-bold">De publicat ({jobs.pending.length})</h2><JobList jobs={jobs.pending} manual /></Card><Card><h2 className="mb-3 font-bold">Publicate recent</h2><JobList jobs={jobs.done} manual /></Card></div></>
}
