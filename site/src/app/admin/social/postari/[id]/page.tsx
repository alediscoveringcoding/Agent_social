import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireAdminPage } from '@/lib/auth/admin'
import { getPost } from '@/lib/social/approval-queries'
// Amendment 07: approval waits until a person has ticked every source as verified.
import { getPostSources } from '@/lib/social/sources-queries'
import { postAskedForResearch } from '@/lib/social/research-queries'
import { formatBucharest } from '@/lib/social/time'
import { Card, PageTitle } from '@/components/ui'
import { SourcesPanel } from '../../SourcesPanel'
import { StatusChip } from '../StatusChip'
import { PostControls } from './PostControls'
import { createAdminClient } from '@/lib/supabase/admin'
import { NativeResolution } from './NativeResolution'

export const metadata: Metadata = { title: 'Programare postare' }
export default async function PostPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireAdminPage(`/admin/social/postari/${id}`)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound()
  const post = await getPost(id)
  if (!post) notFound()
  const sources = await getPostSources(post.id)
  const sourcesMissing = !sources.length && (await postAskedForResearch(post.id))
  const pendingJobs = [...post.destinations.flatMap((destination) => destination.job ? [destination.job] : []), ...post.earlierJobs].filter((job) => job.status === 'reconciling')
  const journal = pendingJobs.length ? await createAdminClient().from('social_native_publications').select('job_id,state').in('job_id', pendingJobs.map((job) => job.id)) : { data: [], error: null }
  const unresolved = new Set((journal.data || []).filter((row) => ['publishing', 'processing', 'unknown'].includes(row.state)).map((row) => row.job_id))
  return <>
    <p className="mb-2 text-sm"><Link href="/admin/social/postari" className="font-semibold text-accent-dark">← Postari</Link></p>
    <PageTitle title={post.title || '(fara titlu)'} subtitle={`${post.brand.name} · revizia ${post.revision.number} · actualizata ${formatBucharest(post.updated_at)}`} actions={<StatusChip status={post.status} />} />
    {/* W1: remount inputs after a revision changes, including a failed approval that saved its times. */}
    {sources.length ? <div className="mb-4"><SourcesPanel sources={sources} locked={Boolean(post.approval)} /></div> : null}
    <PostControls key={post.revision.id} post={post} sourcesUnverified={sources.filter((source) => !source.verified_at).length} sourcesMissing={sourcesMissing} />
    <div className="mt-5"><NativeResolution jobs={pendingJobs.filter((job) => unresolved.has(job.id)).map((job) => ({ id: job.id, name: `${job.platform} · ${job.account_name}` }))} /></div>
    <div className="mt-6 grid gap-4 lg:grid-cols-2">
      <Card><h2 className="mb-3 font-bold">Istoric aprobari</h2>{!post.approvals.length ? <p className="text-sm text-ink-soft">Nicio aprobare.</p> : <ul className="space-y-3 text-sm">{post.approvals.map((approval) => <li key={approval.id}><p className="font-semibold">Revizia {approval.revision_number} · {formatBucharest(approval.approved_at)}</p><p className="text-ink-soft">{approval.approved_by_email ?? '-'} · {approval.revoked_at ? `Revocata: ${approval.revoked_reason ?? 'revizie noua'} (${formatBucharest(approval.revoked_at)})` : 'Activa'}</p><p className="break-all text-xs text-ink-soft">Hash: {approval.approval_hash}</p></li>)}</ul>}</Card>
      <Card><h2 className="mb-3 font-bold">Activitate</h2>{!post.activity.length ? <p className="text-sm text-ink-soft">Nicio actiune inregistrata.</p> : <ul className="space-y-2 text-sm">{post.activity.map((entry) => <li key={entry.id}><p className="font-semibold">{entry.action}</p><p className="text-ink-soft">{entry.actor_email ?? '-'} · {formatBucharest(entry.created_at)}</p></li>)}</ul>}</Card>
    </div>
  </>
}
