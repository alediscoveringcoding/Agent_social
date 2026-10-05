import type { Metadata } from 'next'
import Link from 'next/link'
import { requireAdminPage } from '@/lib/auth/admin'
import { listPosts, POST_FILTERS, isPostFilter } from '@/lib/social/approval-queries'
import { PLATFORM_LABELS } from '@/lib/social/constants'
import { isHttpUrl } from '@/lib/social/schemas'
import { formatBucharest } from '@/lib/social/time'
import { Empty, PageTitle } from '@/components/ui'
import { StatusChip } from './StatusChip'

export const metadata: Metadata = { title: 'Postari' }
export default async function PostsPage({ searchParams }: { searchParams: Promise<{ stare?: string | string[] }> }) {
  await requireAdminPage('/admin/social/postari')
  const { stare } = await searchParams
  const filter = isPostFilter(stare) ? stare : 'active'
  const posts = await listPosts(filter)
  return <>
    <PageTitle title="Postari" subtitle="Programari si rezultate pe fiecare destinatie. Orele sunt ale Bucurestiului." />
    <nav aria-label="Filtre postari" className="mb-5 flex flex-wrap gap-2">
      {Object.entries(POST_FILTERS).map(([key, tab]) => <Link key={key} href={`/admin/social/postari?stare=${key}`} aria-current={filter === key ? 'page' : undefined} className={`rounded-lg px-3 py-2 text-sm font-semibold ${filter === key ? 'bg-accent-soft text-accent-dark' : 'border border-line hover:bg-bg-mint'}`}>{tab.label}</Link>)}
    </nav>
    {!posts.length ? <Empty title="Nicio postare in acest filtru."><Link href="/admin/social/ciorne" className="text-accent-dark">Deschide ciornele</Link> pentru verificare si aprobare.</Empty> : <ul className="space-y-3">
      {posts.map((post) => <li key={post.id} className="rounded-card border border-line bg-card p-4 shadow-card">
        <div className="flex flex-wrap justify-between gap-3"><div><Link href={`/admin/social/postari/${post.id}`} className="font-bold text-ink hover:text-accent-dark">{post.title || '(fara titlu)'}</Link><p className="mt-1 text-xs text-ink-soft">{post.brand?.name ?? '-'} · revizia {post.revision_number ?? '-'} · actualizata {formatBucharest(post.updated_at)}</p></div><StatusChip status={post.status} /></div>
        <ul className="mt-3 space-y-2">{[...post.destinations, ...post.earlier].map((dest) => <li key={dest.destination_id} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold">{PLATFORM_LABELS[dest.platform]}</span><span className="text-ink-soft">{dest.account_name} · {formatBucharest(dest.job?.run_at ?? dest.scheduled_at)}</span><StatusChip status={dest.job?.status ?? 'draft'} />
          {'revision_number' in dest ? <span className="text-xs text-ink-soft">revizia {String(dest.revision_number)}</span> : null}
          {dest.job?.remote_url && isHttpUrl(dest.job.remote_url) ? <a href={dest.job.remote_url} target="_blank" rel="noreferrer" className="font-semibold text-accent-dark hover:underline">Vezi publicarea ↗</a> : null}
          {dest.job?.last_error_code ? <span className="text-xs text-danger" title={dest.job.last_error_message ?? undefined}>{dest.job.last_error_code}</span> : null}
        </li>)}</ul>
      </li>)}
    </ul>}
    {posts.length === 200 ? <p className="mt-4 text-sm text-ink-soft">Sunt afisate cele mai recente 200 de postari.</p> : null}
  </>
}
