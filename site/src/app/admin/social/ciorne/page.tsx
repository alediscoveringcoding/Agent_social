import type { Metadata } from 'next'
import Link from 'next/link'
import { requireAdminPage } from '@/lib/auth/admin'
import { listDrafts } from '@/lib/social/queries'
import { PLATFORM_LABELS } from '@/lib/social/constants'
import { formatBucharest } from '@/lib/social/time'
import { Badge, Empty, PageTitle } from '@/components/ui'
import { DiscardButton } from './DiscardButton'

export const metadata: Metadata = { title: 'Ciorne' }

export default async function DraftsPage() {
  await requireAdminPage('/admin/social/ciorne')
  const drafts = await listDrafts()
  const blocked = drafts.filter((d) => d.destinations.some((x) => !x.ok) || d.unverified_figures > 0).length

  return (
    <>
      <PageTitle
        title="Ciorne"
        subtitle={
          drafts.length === 0
            ? 'Nicio ciorna de verificat.'
            : `${drafts.length} ${drafts.length === 1 ? 'ciorna' : 'ciorne'}, ${blocked} cu probleme de rezolvat inainte de aprobare.`
        }
        actions={
          <Link
            href="/admin/social/genereaza"
            className="rounded-lg bg-primary px-3.5 py-2 text-sm font-bold text-on-primary hover:opacity-90"
          >
            Genereaza ciorne
          </Link>
        }
      />
      {drafts.length === 0 ? (
        <Empty title="Inboxul e gol.">
          Cere ciorne din <Link className="font-semibold text-accent-dark" href="/admin/social/genereaza">Genereaza</Link>.
          Apar aici in cateva minute, dupa ce generatorul le scrie.
        </Empty>
      ) : (
        <ul className="space-y-3">
          {drafts.map((d) => {
            const errorCount = d.destinations.reduce((n, x) => n + x.errors.length, 0)
            return (
              <li key={d.id} className="rounded-card border border-line bg-card p-4 shadow-card">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link href={`/admin/social/ciorne/${d.id}`} className="text-base font-bold text-ink hover:text-accent-dark">
                      {d.title || '(fara titlu)'}
                    </Link>
                    <p className="mt-0.5 text-xs text-ink-soft">
                      {d.brand?.name ?? '-'} · {d.kind === 'social' ? 'postare' : d.kind === 'article' ? 'articol' : 'lansare'} · revizia{' '}
                      {d.revision?.number ?? '-'} · {d.generation_request_id ? 'din generator' : 'manuala'} ·{' '}
                      {formatBucharest(d.updated_at)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {errorCount === 0 && d.unverified_figures === 0 ? (
                      <Badge tone="accent">Fara erori</Badge>
                    ) : (
                      <Badge tone="danger">
                        {errorCount} {errorCount === 1 ? 'eroare' : 'erori'}
                      </Badge>
                    )}
                    {d.unverified_figures > 0 ? <Badge tone="gold">{d.unverified_figures} cifre neverificate</Badge> : null}
                    <Link
                      href={`/admin/social/ciorne/${d.id}`}
                      className="rounded-lg border border-line-2 px-3 py-1.5 text-sm font-semibold text-ink hover:bg-bg-mint"
                    >
                      Deschide
                    </Link>
                    <DiscardButton postId={d.id} title={d.title} />
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {d.destinations.length === 0 ? (
                    <span className="text-xs text-warn">Nicio destinatie: brandul nu are conturi pentru platformele cerute.</span>
                  ) : (
                    d.destinations.map((x) => (
                      <span
                        key={x.id}
                        title={x.errors.join(', ') || 'Fara erori'}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${
                          x.ok ? 'border-line text-ink-soft' : 'border-danger/40 bg-danger-soft text-danger'
                        }`}
                      >
                        {PLATFORM_LABELS[x.platform]}
                        {x.errors.length ? <span>· {x.errors.join(', ')}</span> : null}
                      </span>
                    ))
                  )}
                </div>
                {d.revision?.generator_errors.length ? (
                  <p className="mt-2 text-xs text-ink-soft">
                    Generatorul a semnalat: {d.revision.generator_errors.map((e) => e.message).join(' · ')}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}
