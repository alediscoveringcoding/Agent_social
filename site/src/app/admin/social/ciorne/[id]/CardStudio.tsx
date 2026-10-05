'use client'
import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { generateCards } from '@/lib/social/media-actions'
import { PLATFORM_CARD_FORMAT, type Platform } from '@/lib/social/constants'
import { normalizeCardSpec, checkCardSpec, defaultCardAlt } from '@/lib/social/cards/spec'
import { cardCopyIssues } from '@/lib/social/cards/copy'
import type { DraftDetail } from '@/lib/social/queries'
import { Button, Card, Field, inputClass } from '@/components/ui'

export function CardStudio({ draft, accountId, platform, disabled, dirty }: { draft: DraftDetail; accountId: string; platform: Platform; disabled: boolean; dirty: boolean }) {
  const [spec, setSpec] = useState(() => {
    const initial = normalizeCardSpec({ ...(draft.revision.card_spec ?? {}), headline: String(draft.revision.card_spec?.headline ?? draft.title ?? ''), brand: draft.brand.slug })
    return { ...initial, alt_text: initial.alt_text || defaultCardAlt(initial, draft.brand.name) }
  })
  const [preview, setPreview] = useState('')
  const [pending, start] = useTransition()
  const router = useRouter()
  const issues = checkCardSpec(spec, { requireAlt: true })
  const copyIssues = cardCopyIssues(spec)
  useEffect(() => {
    if (checkCardSpec(spec).length || disabled) return
    const timer = setTimeout(() => {
      const q = new URLSearchParams({ postId: draft.id, revisionId: draft.revision.id, format: PLATFORM_CARD_FORMAT[platform], template: spec.template, headline: spec.headline, keyword: spec.keyword ?? '', stat: spec.stat ?? '', subline: spec.subline ?? '' })
      setPreview(`/admin/social/media/card-preview?${q}`)
    }, 450)
    return () => clearTimeout(timer)
  }, [spec, platform, draft.id, draft.revision.id, disabled])
  function generate(all: boolean) {
    start(async () => {
      const result = await generateCards({ postId: draft.id, baseRevisionId: draft.revision.id, spec, accountIds: all ? undefined : [accountId] })
      if (!result.ok) toast.error(result.error)
      else { toast.success('Carduri generate si atasate ca revizie noua.'); router.refresh() }
    })
  }
  const textField = (key: 'headline' | 'keyword' | 'stat' | 'subline' | 'alt_text', label: string, max: number) => <Field label={label}><input className={inputClass} disabled={disabled || pending} maxLength={max} value={spec[key] ?? ''} onChange={(e) => setSpec({ ...spec, [key]: e.target.value })} /></Field>
  return <Card><h2 className="mb-3 text-sm font-bold text-ink">Studio de carduri</h2><div className="space-y-3">
    <Field label="Sablon"><select className={inputClass} value={spec.template} disabled={disabled || pending} onChange={(e) => setSpec({ ...spec, template: e.target.value as typeof spec.template })}><option value="light">Light</option><option value="dark">Dark</option><option value="mint">Mint</option></select></Field>
    {textField('headline', 'Titlu', 70)}{textField('keyword', 'Cuvant evidentiat', 70)}{textField('stat', 'Cifra (optional)', 8)}{textField('subline', 'Subtitlu', 110)}{textField('alt_text', 'Text alternativ', 1000)}
    {preview ? <img src={preview} alt={spec.alt_text ?? ''} className="w-full rounded-lg border border-line" /> : null /* eslint-disable-line @next/next/no-img-element */}
    {issues.map((issue) => <p key={issue.field} className="text-xs text-danger">{issue.message}</p>)}
    {copyIssues.map((issue) => <p key={issue} className="text-xs text-danger">{issue}</p>)}
    {dirty ? <p className="text-xs text-warn">Salveaza textul inainte de a genera cardurile.</p> : null}
    <p className="text-xs text-ink-soft">Generarea inlocuieste imaginile destinatiei cu noul card.</p>
    <div className="flex flex-wrap gap-2"><Button disabled={disabled || dirty || pending || !!issues.length || !!copyIssues.length} onClick={() => generate(false)}>Genereaza aici</Button><Button tone="secondary" disabled={disabled || dirty || pending || !!issues.length || !!copyIssues.length} onClick={() => generate(true)}>Pentru toate destinatiile</Button></div>
  </div></Card>
}
