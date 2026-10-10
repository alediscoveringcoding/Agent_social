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
import { altIsAuto, altMissesFigure } from './ui-helpers'

export function CardStudio({ draft, accountId, platform, legalNames = [], disabled, dirty, onBusyChange }: { draft: DraftDetail; accountId: string; platform: Platform; legalNames?: string[]; disabled: boolean; dirty: boolean; onBusyChange: (busy: boolean) => void }) {
  const [spec, setSpec] = useState(() => {
    const attached = draft.destinations.find((d) => d.account_id === accountId)?.media.find((m) => m.card_spec)?.card_spec
    const current = attached ?? draft.revision.card_spec
    const initial = normalizeCardSpec({ ...(current ?? {}), headline: String(current?.headline ?? draft.title ?? ''), brand: draft.brand.slug })
    return { ...initial, alt_text: initial.alt_text || defaultCardAlt(initial, draft.brand.name) }
  })
  const [preview, setPreview] = useState('')
  const [pending, start] = useTransition()
  useEffect(() => { onBusyChange(pending) }, [pending, onBusyChange])
  useEffect(() => () => onBusyChange(false), [onBusyChange])
  const router = useRouter()
  const issues = checkCardSpec(spec, { requireAlt: true })
  const copyIssues = cardCopyIssues(spec, legalNames)
  useEffect(() => {
    if (checkCardSpec(spec).length || cardCopyIssues(spec, legalNames).length || disabled) return
    const timer = setTimeout(() => {
      const q = new URLSearchParams({ postId: draft.id, revisionId: draft.revision.id, format: PLATFORM_CARD_FORMAT[platform], template: spec.template, headline: spec.headline, keyword: spec.keyword ?? '', stat: spec.stat ?? '', subline: spec.subline ?? '' })
      setPreview(`/admin/social/media/card-preview?${q}`)
    }, 450)
    return () => clearTimeout(timer)
  }, [spec, platform, draft.id, draft.revision.id, disabled, legalNames])
  function generate(all: boolean) {
    onBusyChange(true)
    start(async () => {
      try {
        const result = await generateCards({ postId: draft.id, baseRevisionId: draft.revision.id, spec, accountIds: all ? undefined : [accountId] })
        if (!result.ok) toast.error(result.error)
        else { toast.success('Carduri generate si atasate ca revizie noua.'); router.refresh() }
      } catch { toast.error('Generarea a esuat. Incearca din nou.') }
    })
  }
  // The alt text follows headline, figure and subline until someone edits it by hand.
  function update(key: 'headline' | 'keyword' | 'stat' | 'subline' | 'alt_text', value: string) {
    const next = { ...spec, [key]: value }
    if (key === 'headline' || key === 'stat' || key === 'subline') {
      if (altIsAuto(spec.alt_text, defaultCardAlt(spec, draft.brand.name))) next.alt_text = defaultCardAlt(next, draft.brand.name)
    }
    setSpec(next)
  }
  const textField = (key: 'headline' | 'keyword' | 'stat' | 'subline' | 'alt_text', label: string, max: number) => <Field label={label}><input className={inputClass} disabled={disabled || pending} maxLength={max} value={spec[key] ?? ''} onChange={(e) => update(key, e.target.value)} /></Field>
  return <Card><h2 className="mb-3 text-sm font-bold text-ink">Studio de carduri</h2><div className="space-y-3">
    <Field label="Sablon"><select className={inputClass} value={spec.template} disabled={disabled || pending} onChange={(e) => setSpec({ ...spec, template: e.target.value as typeof spec.template })}><option value="light">Light</option><option value="dark">Dark</option><option value="mint">Mint</option></select></Field>
    {textField('headline', 'Titlu', 70)}{textField('keyword', 'Cuvant evidentiat', 70)}{textField('stat', 'Cifra (optional)', 8)}{textField('subline', 'Subtitlu', 110)}{textField('alt_text', 'Text alternativ', 1000)}
    {preview && !issues.length && !copyIssues.length ? <img src={preview} alt={spec.alt_text ?? ''} className="w-full rounded-lg border border-line" /> : null /* eslint-disable-line @next/next/no-img-element */}
    {spec.alt_text && altMissesFigure(spec.alt_text, spec.stat) ? <p className="text-xs text-warn">Textul alternativ nu mai contine cifra cardului.</p> : null}
    {issues.map((issue) => <p key={issue.field} className="text-xs text-danger">{issue.message}</p>)}
    {copyIssues.map((issue) => <p key={issue} className="text-xs text-danger">{issue}</p>)}
    {dirty ? <p className="text-xs text-warn">Salveaza textul inainte de a genera cardurile.</p> : null}
    <p className="text-xs text-ink-soft">Generarea inlocuieste imaginile destinatiei cu noul card.</p>
    <div className="flex flex-wrap gap-2"><Button disabled={disabled || dirty || pending || !!issues.length || !!copyIssues.length} onClick={() => generate(false)}>Genereaza aici</Button><Button tone="secondary" disabled={disabled || dirty || pending || !!issues.length || !!copyIssues.length} onClick={() => generate(true)}>Pentru toate destinatiile</Button></div>
  </div></Card>
}
