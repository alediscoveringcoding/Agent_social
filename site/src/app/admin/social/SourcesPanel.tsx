'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge, Button, Card } from '@/components/ui'
import { SOURCES_FROZEN_HINT } from '@/lib/social/constants'
import {
  approvalBlockedHint,
  effectiveVerified,
  formatSourcesForComment,
  isSafeSourceUrl,
  sourceMeta,
  sourcesHeader,
  sourcesProgress,
  sourceTitle,
  verifierName,
  type OptimisticVerify,
} from '@/lib/social/news-ui'
import type { PostSource } from '@/lib/social/sources-queries'
import { setSourceVerified } from '@/lib/social/sources-actions'
import { formatBucharest } from '@/lib/social/time'

/**
 * The web sources behind a draft (amendment 07). A person opens each link and
 * ticks "Verificat"; approval stays blocked until every one is ticked, and the
 * ticks freeze with the approval. Hidden when the post has no sources.
 */
export function SourcesPanel({ sources, locked }: { sources: PostSource[]; locked: boolean }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  // A click shows at once; it holds only while the server still shows the value it started from.
  const [optimistic, setOptimistic] = useState<Record<string, OptimisticVerify>>({})

  if (sources.length === 0) return null

  const { verified, total, unverified } = sourcesProgress(sources, optimistic)
  const blocked = locked ? null : approvalBlockedHint(unverified)

  function undo(id: string) {
    setOptimistic((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)))
  }

  function toggle(source: PostSource, wanted: boolean) {
    if (pending || locked) return
    setOptimistic((current) => ({ ...current, [source.id]: { value: wanted, base: Boolean(source.verified_at) } }))
    start(async () => {
      try {
        const result = await setSourceVerified(source.id, wanted)
        if (!result.ok) {
          toast.error(result.error)
          undo(source.id)
        }
      } catch {
        toast.error('Sursa nu a putut fi actualizata. Incearca din nou.')
        undo(source.id)
      } finally {
        router.refresh()
      }
    })
  }

  async function copy() {
    const text = formatSourcesForComment(sources)
    if (!text) {
      toast.error('Nicio sursa cu link valid de copiat.')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Sursele au fost copiate. Lipeste-le in primul comentariu.')
    } catch {
      toast.error('Nu am putut copia. Incearca din nou sau copiaza linkurile de mana.')
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-bold text-ink">Surse</h2>
          <p className="mt-0.5 text-xs text-ink-soft" aria-live="polite">
            {sourcesHeader(verified, total)}
          </p>
        </div>
        <Button tone="secondary" className="px-2 py-1 text-xs" onClick={copy} title="Lista pentru primul comentariu de pe LinkedIn">
          Copiaza sursele
        </Button>
      </div>

      {blocked ? (
        <p className="mt-3 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs font-semibold text-warn">
          {blocked}
        </p>
      ) : null}
      {locked ? <p className="mt-3 text-xs text-ink-soft">{SOURCES_FROZEN_HINT}</p> : null}

      <ul className="mt-3 space-y-2">
        {sources.map((source) => {
          const isVerified = effectiveVerified(Boolean(source.verified_at), optimistic[source.id])
          const title = sourceTitle(source)
          const meta = sourceMeta(source)
          const by = verifierName(source.verified_by)
          return (
            <li key={source.id} className="rounded-lg border border-line px-3 py-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  {isSafeSourceUrl(source.url) ? (
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-words text-sm font-semibold text-accent-dark hover:underline"
                    >
                      {title} ↗
                    </a>
                  ) : (
                    <span className="break-words text-sm font-semibold text-ink">{title}</span>
                  )}
                  {!isSafeSourceUrl(source.url) ? <p className="text-xs text-danger">Linkul nu e un https valid, nu se poate deschide.</p> : null}
                  {meta ? <p className="text-xs text-ink-soft">{meta}</p> : null}
                  {source.note ? <p className="mt-1 text-xs text-ink-soft">Sustine: {source.note}</p> : null}
                  {isVerified && source.verified_at ? (
                    <p className="mt-1 text-xs text-ink-soft">
                      Verificat{by ? ` de ${by}` : ''}, {formatBucharest(source.verified_at)}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-3">
                  <Badge tone={source.found_in_search ? 'accent' : 'neutral'}>
                    {source.found_in_search ? 'Gasit in cautare' : 'Adaugat manual'}
                  </Badge>
                  <label
                    className="flex items-center gap-1.5 text-sm font-semibold text-ink"
                    title={locked ? SOURCES_FROZEN_HINT : undefined}
                  >
                    <input
                      type="checkbox"
                      checked={isVerified}
                      disabled={locked || pending}
                      onChange={(e) => toggle(source, e.target.checked)}
                      aria-label={`Verificat: ${title}`}
                    />
                    Verificat
                  </label>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
