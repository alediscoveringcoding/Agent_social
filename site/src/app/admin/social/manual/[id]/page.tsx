import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Badge, PageTitle } from '@/components/ui'
import { requireAdminPage } from '@/lib/auth/admin'
import { getManualJob } from '@/lib/social/handoff-queries'
import { JOB_STATUS_LABELS, PLATFORM_LABELS } from '@/lib/social/constants'
import { isUuid } from '@/lib/social/server/run-admin-action'
import { HandoffPanel } from './HandoffPanel'

export const metadata: Metadata = { title: 'Publicare manuala' }
export default async function ManualJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireAdminPage(`/admin/social/manual/${id}`)
  if (!isUuid(id)) notFound()
  const detail = await getManualJob(id)
  if (!detail) notFound()
  return <><Link className="mb-3 inline-block text-sm text-accent-dark" href="/admin/social/manual">← Publicare manuala</Link><PageTitle title={detail.job.post?.title || '(fara titlu)'} subtitle={`${PLATFORM_LABELS[detail.job.platform]} · ${detail.account.display_name} · revizia ${detail.revision.number}`} actions={<Badge tone={detail.job.status === 'manual_done' ? 'accent' : 'warn'}>{JOB_STATUS_LABELS[detail.job.status]}</Badge>} /><HandoffPanel key={`${id}:${detail.job.status}`} detail={detail} /></>
}
