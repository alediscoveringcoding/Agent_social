import type { Metadata } from 'next'
import Link from 'next/link'
import { requireAdminPage } from '@/lib/auth/admin'
import { listAccounts, listBrands, listGenerationRequests } from '@/lib/social/queries'
import { Badge, Card, PageTitle } from '@/components/ui'
import { formatBucharest } from '@/lib/social/time'
import { AI_MODELS, PLATFORM_LABELS, type Platform } from '@/lib/social/constants'
import { requestSourceLabel, requestUsesResearch } from '@/lib/social/news-ui'
import { GenerateForm } from './GenerateForm'

export const metadata: Metadata = { title: 'Genereaza' }

const STATUS: Record<string, { label: string; tone: 'neutral' | 'accent' | 'danger' | 'warn' }> = {
  queued: { label: 'In asteptare', tone: 'neutral' },
  running: { label: 'Se genereaza', tone: 'warn' },
  done: { label: 'Gata', tone: 'accent' },
  failed: { label: 'Esuat', tone: 'danger' },
}

function aiLabel(model: string | undefined): string {
  if (!model) return 'AI implicit'
  return AI_MODELS.find((m) => m.id === model)?.label.replace(/ \(.*\)$/, '') ?? model
}

export default async function GeneratePage() {
  await requireAdminPage('/admin/social/genereaza')
  const [brands, accounts, requests] = await Promise.all([listBrands(), listAccounts(), listGenerationRequests(15)])
  const platformsByBrand: Record<string, Platform[]> = {}
  for (const a of accounts) if (a.brand_id) (platformsByBrand[a.brand_id] ??= []).push(a.platform)

  return (
    <>
      <PageTitle
        title="Genereaza ciorne"
        subtitle="Generatorul scrie ciornele; tu le verifici si le aprobi. Nimic nu se publica fara aprobarea ta."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Card>
          <GenerateForm brands={brands} platformsByBrand={platformsByBrand} />
        </Card>
        <div>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-soft">Cereri recente</h2>
          {requests.length === 0 ? (
            <p className="text-sm text-ink-soft">Nicio cerere inca.</p>
          ) : (
            <ul className="space-y-2">
              {requests.map((r) => {
                const s = STATUS[r.status] ?? STATUS.queued
                const source = requestSourceLabel(r.input.source)
                const research = requestUsesResearch(r.input)
                return (
                  <li key={r.id} className="rounded-card-sm border border-line bg-card px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-ink" title={source}>
                        {source}
                      </span>
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-ink-soft">
                      {r.brand?.name ?? '-'} · {(r.input.platforms ?? []).map((p) => PLATFORM_LABELS[p as Platform] ?? p).join(', ')} ·{' '}
                      {r.input.count ?? '?'} ciorne · {aiLabel(r.input.ai?.model)} · {formatBucharest(r.created_at)}
                      {research ? ' · cu cautare pe web' : ''}
                    </p>
                    {r.status === 'done' ? (
                      <Link href="/admin/social/ciorne" className="mt-1 inline-block text-xs font-semibold text-accent-dark hover:underline">
                        {r.drafts_created} {r.drafts_created === 1 ? 'ciorna' : 'ciorne'} in inbox
                      </Link>
                    ) : null}
                    {r.status === 'failed' ? (
                      <p className="mt-1 text-xs font-semibold text-danger">
                        {r.error_code}: {r.error_message ?? 'fara detalii'}
                      </p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
          <p className="mt-4 text-xs text-ink-soft">
            Cererile sunt preluate de generatorul de pe masina de publicare. Pe localhost, fara worker, porneste{' '}
            <code className="rounded bg-bg-mint px-1">npm run social:fake-generator</code>.
          </p>
        </div>
      </div>
    </>
  )
}
