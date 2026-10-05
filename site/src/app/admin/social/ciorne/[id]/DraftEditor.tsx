'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { saveDraft } from '@/lib/social/actions'
import { PLATFORM_LABELS, type Platform } from '@/lib/social/constants'
import type { EditFigure } from '@/lib/social/draft-edit'
import type { DraftDetail } from '@/lib/social/queries'
import { formatBucharest } from '@/lib/social/time'
import { maxLengthFor, measureLength, validateDestination, type DestinationValidation } from '@/lib/social/validation'
import { Badge, Button, Card, Field, cn, inputClass } from '@/components/ui'
// W2: revision-bound media controls and destination preview.
import type { MediaItem } from '@/lib/social/media-queries'
import { MediaPanel } from './MediaPanel'
import { CardStudio } from './CardStudio'
import { DestinationPreview } from './DestinationPreview'

interface DestState {
  accountId: string
  text: string
  settings: Record<string, unknown>
}

const SOURCE_LABELS: Record<string, { label: string; tone: 'accent' | 'gold' | 'neutral' }> = {
  article: { label: 'din articol', tone: 'accent' },
  facts: { label: 'din fapte verificate', tone: 'accent' },
  confirmed: { label: 'confirmata de om', tone: 'accent' },
  unverified: { label: 'neverificata', tone: 'gold' },
}

/** A starting point for a destination the generator did not create. */
function initialFor(platform: Platform, draft: DraftDetail): DestState['settings'] & { __text: string } {
  const variant = draft.revision.variants.find((v) => v.platform === platform)
  const a = (draft.revision.article ?? {}) as Record<string, unknown>
  const l = (draft.revision.launch ?? {}) as Record<string, unknown>
  const canonical = (a.canonical_url as string) || draft.source_url || ''
  const defaults: Partial<Record<Platform, Record<string, unknown>>> = {
    x: { who_can_reply: 'everyone' },
    instagram: { post_type: 'post' },
    devto: { title: a.title, tags: a.tags, canonical_url: canonical },
    hashnode: { title: a.title, subtitle: a.subtitle, tags: a.tags, canonical_url: canonical },
    substack: { title: a.title, subtitle: a.subtitle },
    producthunt: { name: l.name, tagline: l.tagline, maker_comment: l.maker_comment },
  }
  const base = defaults[platform] ?? {}
  const text =
    variant?.text ||
    (platform === 'producthunt' ? (l.description as string) : undefined) ||
    (['devto', 'hashnode', 'substack'].includes(platform) ? (a.body_markdown as string) : undefined) ||
    draft.revision.canonical_text
  return { ...base, ...(variant?.settings ?? {}), __text: text ?? '' }
}

function SettingsFields({
  platform,
  settings,
  onChange,
  disabled,
}: {
  platform: Platform
  settings: Record<string, unknown>
  onChange: (s: Record<string, unknown>) => void
  disabled: boolean
}) {
  const text = (key: string, label: string, hint?: string) => (
    <Field label={label} hint={hint} key={key}>
      <input
        value={(settings[key] as string) ?? ''}
        disabled={disabled}
        onChange={(e) => onChange({ ...settings, [key]: e.target.value })}
        className={inputClass}
      />
    </Field>
  )
  const tags = (max: number) => (
    <Field label="Etichete" hint={`Separate prin virgula, cel mult ${max}.`} key="tags">
      <input
        value={Array.isArray(settings.tags) ? (settings.tags as string[]).join(', ') : ((settings.tags as string) ?? '')}
        disabled={disabled}
        onChange={(e) => onChange({ ...settings, tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
        className={inputClass}
      />
    </Field>
  )
  switch (platform) {
    case 'x':
      return (
        <Field label="Cine poate raspunde">
          <select
            value={(settings.who_can_reply as string) ?? 'everyone'}
            disabled={disabled}
            onChange={(e) => onChange({ ...settings, who_can_reply: e.target.value })}
            className={inputClass}
          >
            <option value="everyone">Oricine</option>
            <option value="following">Conturile urmarite</option>
            <option value="mentionedUsers">Doar cei mentionati</option>
          </select>
        </Field>
      )
    case 'devto':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {text('title', 'Titlu')}
          {text('canonical_url', 'Link canonic', 'Articolul de pe blogul nostru.')}
          {tags(4)}
        </div>
      )
    case 'hashnode':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {text('title', 'Titlu')}
          {text('subtitle', 'Subtitlu')}
          {text('canonical_url', 'Link canonic', 'Articolul de pe blogul nostru.')}
          {tags(5)}
        </div>
      )
    case 'substack':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {text('title', 'Titlu')}
          {text('subtitle', 'Subtitlu')}
        </div>
      )
    case 'producthunt':
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {text('name', 'Nume')}
          {text('tagline', 'Tagline', 'Cel mult 60 de caractere.')}
          <div className="sm:col-span-2">{text('maker_comment', 'Comentariul makerului')}</div>
        </div>
      )
    default:
      return null
  }
}

function Issues({ v }: { v: DestinationValidation }) {
  if (!v.errors.length && !v.warnings.length) {
    return <p className="text-xs font-semibold text-accent-dark">Respecta regulile de continut.</p>
  }
  return (
    <ul className="space-y-1 text-xs">
      {v.errors.map((e, i) => (
        <li key={`e${i}`} className="font-semibold text-danger">
          {e.message}
        </li>
      ))}
      {v.warnings.map((w, i) => (
        <li key={`w${i}`} className="text-warn">
          {w.message}
        </li>
      ))}
    </ul>
  )
}

export function DraftEditor({ draft, editable, mediaLibrary = [] }: { draft: DraftDetail; editable: boolean; mediaLibrary?: MediaItem[] }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [title, setTitle] = useState(draft.title ?? '')
  const [canonical, setCanonical] = useState(draft.revision.canonical_text)
  const [figures, setFigures] = useState<EditFigure[]>(draft.revision.figures)
  const [dests, setDests] = useState<DestState[]>(
    draft.destinations.map((d) => ({ accountId: d.account_id, text: d.text, settings: d.settings }))
  )
  const [active, setActive] = useState<string | null>(draft.destinations[0]?.account_id ?? null)
  const [newFigure, setNewFigure] = useState({ value: '', context: '' })
  const [dirty, setDirty] = useState(false)

  const accounts = useMemo(() => new Map(draft.accounts.map((a) => [a.id, a])), [draft.accounts])
  const mediaByAccount = useMemo(
    () => new Map(draft.destinations.map((d) => [d.account_id, d.media])),
    [draft.destinations]
  )

  const validations = useMemo(() => {
    const out = new Map<string, DestinationValidation>()
    for (const d of dests) {
      const acc = accounts.get(d.accountId)
      if (!acc) continue
      const v = validateDestination({
        platform: acc.platform,
        kind: draft.kind,
        text: d.text,
        settings: d.settings,
        media: (mediaByAccount.get(d.accountId) ?? []).map((m) => ({ mediaId: m.media_id, mime: m.mime, width: m.width, height: m.height, altText: m.alt_text })),
        figures,
        rules: acc.rules,
      })
      // The time is chosen at approval; it is not a drafting problem.
      out.set(d.accountId, { ...v, errors: v.errors.filter((e) => e.code !== 'MISSING_TIME' && e.code !== 'TIME_IN_PAST'), ok: v.errors.every((e) => e.code === 'MISSING_TIME' || e.code === 'TIME_IN_PAST') })
    }
    return out
  }, [dests, accounts, mediaByAccount, figures, draft.kind])

  const totalErrors = [...validations.values()].reduce((n, v) => n + v.errors.length, 0)
  const change = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v)
    setDirty(true)
  }

  function toggleAccount(accountId: string) {
    const acc = accounts.get(accountId)
    if (!acc) return
    if (dests.some((d) => d.accountId === accountId)) {
      const next = dests.filter((d) => d.accountId !== accountId)
      setDests(next)
      if (active === accountId) setActive(next[0]?.accountId ?? null)
    } else {
      const { __text, ...settings } = initialFor(acc.platform, draft)
      setDests([...dests, { accountId, text: __text, settings }])
      setActive(accountId)
    }
    setDirty(true)
  }

  function updateDest(accountId: string, patch: Partial<DestState>) {
    setDests(dests.map((d) => (d.accountId === accountId ? { ...d, ...patch } : d)))
    setDirty(true)
  }

  function save() {
    start(async () => {
      const r = await saveDraft({
        postId: draft.id,
        baseRevisionId: draft.revision.id,
        edit: { title, canonicalText: canonical, figures, destinations: dests },
      })
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      setDirty(false)
      toast.success(r.errors ? `Salvat ca revizie noua. Mai sunt ${r.errors} erori de rezolvat.` : 'Salvat ca revizie noua, fara erori.')
      router.refresh()
    })
  }

  const activeDest = dests.find((d) => d.accountId === active) ?? null
  const activeAcc = activeDest ? accounts.get(activeDest.accountId) : undefined
  const activeV = activeDest ? validations.get(activeDest.accountId) : undefined
  const variant = activeAcc ? draft.revision.variants.find((v) => v.platform === activeAcc.platform) : undefined

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="space-y-6">
        {draft.revision.notes || draft.revision.generator_errors.length ? (
          <Card className="bg-bg-mint">
            {draft.revision.notes ? <p className="whitespace-pre-line text-sm text-ink">{draft.revision.notes}</p> : null}
            {draft.revision.generator_errors.length ? (
              <ul className="mt-2 list-disc pl-5 text-sm text-warn">
                {draft.revision.generator_errors.map((e, i) => (
                  <li key={i}>
                    {e.code ? <span className="font-semibold">{e.code}: </span> : null}
                    {e.message}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        ) : null}

        <Card>
          <div className="space-y-4">
            <Field label="Titlu intern" hint="Apare doar in panou.">
              <input value={title} disabled={!editable} onChange={(e) => change(setTitle)(e.target.value)} className={inputClass} />
            </Field>
            <Field label="Textul de baza" hint="Mesajul comun din care pleaca variantele pe platforme.">
              <textarea
                value={canonical}
                disabled={!editable}
                onChange={(e) => change(setCanonical)(e.target.value)}
                rows={3}
                className={inputClass}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <h2 className="text-sm font-bold text-ink">Platforme</h2>
          <p className="mt-0.5 text-xs text-ink-soft">Bifeaza conturile brandului pe care merge postarea. Fiecare are textul ei.</p>
          {draft.accounts.length === 0 ? (
            <p className="mt-3 text-sm text-warn">Brandul nu are inca niciun cont. Conturile se adauga din Postiz si apar aici dupa sincronizare.</p>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              {draft.accounts.map((a) => {
                const on = dests.some((d) => d.accountId === a.id)
                return (
                  <label
                    key={a.id}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm',
                      on ? 'border-accent bg-accent-soft text-accent-dark' : 'border-line-2 text-ink-soft'
                    )}
                  >
                    <input type="checkbox" checked={on} disabled={!editable} onChange={() => toggleAccount(a.id)} />
                    {PLATFORM_LABELS[a.platform]} · {a.display_name}
                    {a.paused ? <Badge tone="warn">pe pauza</Badge> : null}
                  </label>
                )
              })}
            </div>
          )}

          {dests.length ? (
            <div className="mt-5">
              <div className="flex flex-wrap gap-1 border-b border-line">
                {dests.map((d) => {
                  const acc = accounts.get(d.accountId)
                  const v = validations.get(d.accountId)
                  return (
                    <button
                      key={d.accountId}
                      type="button"
                      onClick={() => setActive(d.accountId)}
                      className={cn(
                        '-mb-px rounded-t-lg border border-b-0 px-3 py-2 text-sm font-semibold',
                        active === d.accountId ? 'border-line bg-card text-ink' : 'border-transparent text-ink-soft hover:text-ink'
                      )}
                    >
                      {acc ? PLATFORM_LABELS[acc.platform] : '?'}
                      {v && v.errors.length ? <span className="ml-1.5 text-danger">●</span> : null}
                    </button>
                  )
                })}
              </div>
              {activeDest && activeAcc && activeV ? (
                <div className="space-y-4 pt-4">
                  <Field
                    label={`Text pentru ${PLATFORM_LABELS[activeAcc.platform]}`}
                    hint={
                      <span className={cn(activeV.maxLength !== null && activeV.length > activeV.maxLength && 'font-bold text-danger')}>
                        {measureLength(activeAcc.platform, activeDest.text)}
                        {maxLengthFor(activeAcc.platform, activeAcc.rules) !== null ? ` / ${maxLengthFor(activeAcc.platform, activeAcc.rules)}` : ''}{' '}
                        {activeAcc.platform === 'x' ? 'caractere ponderate X (un link = 23)' : 'caractere'}
                      </span>
                    }
                  >
                    <textarea
                      value={activeDest.text}
                      disabled={!editable}
                      onChange={(e) => updateDest(activeDest.accountId, { text: e.target.value })}
                      rows={['devto', 'hashnode', 'substack'].includes(activeAcc.platform) ? 14 : 6}
                      className={cn(inputClass, ['devto', 'hashnode', 'substack'].includes(activeAcc.platform) && 'font-mono text-xs')}
                    />
                  </Field>
                  {variant && variant.text && variant.text !== activeDest.text && editable ? (
                    <Button tone="ghost" onClick={() => updateDest(activeDest.accountId, { text: variant.text })} className="px-2 py-1 text-xs">
                      Foloseste varianta generatorului
                    </Button>
                  ) : null}
                  <SettingsFields
                    platform={activeAcc.platform}
                    settings={activeDest.settings}
                    disabled={!editable}
                    onChange={(s) => updateDest(activeDest.accountId, { settings: s })}
                  />
                  <Issues v={activeV} />
                </div>
              ) : null}
            </div>
          ) : null}
        </Card>

        <Card>
          <h2 className="text-sm font-bold text-ink">Cifre</h2>
          <p className="mt-0.5 text-xs text-ink-soft">
            O cifra neverificata blocheaza aprobarea. Confirm-o doar dupa ce ai verificat-o la sursa, sau scoate-o din text si din lista.
          </p>
          {figures.length === 0 ? <p className="mt-3 text-sm text-ink-soft">Nicio cifra listata.</p> : null}
          <ul className="mt-3 space-y-2">
            {figures.map((f, i) => {
              const s = SOURCE_LABELS[f.source] ?? { label: f.source, tone: 'neutral' as const }
              return (
                <li key={`${f.value}-${i}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2">
                  <div className="min-w-0">
                    <span className="font-bold text-ink">{f.value}</span>{' '}
                    <span className="text-sm text-ink-soft">{f.context ?? ''}</span>
                    {f.confirmed_by ? (
                      <span className="block text-xs text-ink-soft">
                        confirmata de {f.confirmed_by}
                        {f.confirmed_at ? `, ${formatBucharest(f.confirmed_at)}` : ''}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={s.tone}>{s.label}</Badge>
                    {editable && f.source === 'unverified' ? (
                      <Button
                        tone="secondary"
                        className="px-2 py-1 text-xs"
                        onClick={() => change(setFigures)(figures.map((x, j) => (j === i ? { ...x, source: 'confirmed' } : x)))}
                      >
                        Am verificat-o
                      </Button>
                    ) : null}
                    {editable ? (
                      <Button tone="ghost" className="px-2 py-1 text-xs" onClick={() => change(setFigures)(figures.filter((_, j) => j !== i))}>
                        Scoate
                      </Button>
                    ) : null}
                  </div>
                </li>
              )
            })}
          </ul>
          {editable ? (
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <input
                placeholder="Cifra, ex. 16%"
                value={newFigure.value}
                onChange={(e) => setNewFigure({ ...newFigure, value: e.target.value })}
                className={cn(inputClass, 'w-36')}
              />
              <input
                placeholder="Contextul si sursa"
                value={newFigure.context}
                onChange={(e) => setNewFigure({ ...newFigure, context: e.target.value })}
                className={cn(inputClass, 'min-w-48 flex-1')}
              />
              <Button
                tone="secondary"
                disabled={!newFigure.value.trim()}
                onClick={() => {
                  change(setFigures)([...figures, { value: newFigure.value.trim(), context: newFigure.context.trim() || null, source: 'confirmed' }])
                  setNewFigure({ value: '', context: '' })
                }}
              >
                Adauga cifra verificata
              </Button>
            </div>
          ) : null}
        </Card>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        <Card>
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-ink">
              {totalErrors === 0 ? 'Fara erori' : `${totalErrors} ${totalErrors === 1 ? 'eroare' : 'erori'}`}
            </span>
            {dirty ? <Badge tone="warn">Nesalvat</Badge> : null}
          </div>
          <p className="mt-1 text-xs text-ink-soft">
            Salvarea face o revizie noua; cea veche ramane in istoric. Aprobarea si programarea vin in pasul urmator.
          </p>
          <Button className="mt-3 w-full" onClick={save} disabled={!editable || pending || dests.length === 0}>
            {pending ? 'Se salveaza...' : 'Salveaza revizia'}
          </Button>
        </Card>

        {/* W2: disable revision changes until unsaved copy is saved. */}
        {activeDest && activeAcc ? (
          <>
            <DestinationPreview accountName={activeAcc.display_name} platform={activeAcc.platform} text={activeDest.text} settings={activeDest.settings} media={mediaByAccount.get(activeDest.accountId) ?? []} />
            <MediaPanel key={`${draft.revision.id}:${activeDest.accountId}`} draft={draft} accountId={activeDest.accountId} items={mediaLibrary} disabled={!editable || pending} dirty={dirty} />
            <CardStudio key={draft.revision.id} draft={draft} accountId={activeDest.accountId} platform={activeAcc.platform} disabled={!editable || pending} dirty={dirty} />
          </>
        ) : null}

        <Card>
          <p className="text-xs font-bold uppercase tracking-wide text-ink-soft">Revizii</p>
          <ul className="mt-2 space-y-1 text-xs text-ink-soft">
            {draft.revisions.map((r) => (
              <li key={r.id} className={cn(r.id === draft.revision.id && 'font-semibold text-ink')}>
                #{r.number} · {formatBucharest(r.created_at)} · {r.created_by_email ?? 'generator'}
              </li>
            ))}
          </ul>
        </Card>
      </aside>
    </div>
  )
}
