'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createGenerationRequest } from '@/lib/social/actions'
import {
  AI_MODELS,
  CARD_TEMPLATES,
  CARD_TEMPLATE_LABELS,
  GENERATION_SOURCE_LABELS,
  GENERATION_SOURCE_TYPES,
  NEWS_WINDOW_DAYS,
  PLATFORMS,
  PLATFORM_LABELS,
  type CardTemplate,
  type GenerationSourceType,
  type Platform,
} from '@/lib/social/constants'
import { HOOKS_MAX, NO_TEMPLATE_MESSAGE, RESEARCH_COST_NOTE, buildGenerationForm, hooksIssue, validateGenerationState } from '@/lib/social/news-ui'
import { Button, Field, inputClass } from '@/components/ui'

interface Props {
  brands: Array<{ id: string; slug: string; name: string }>
  platformsByBrand: Record<string, Platform[]>
}

export function GenerateForm({ brands, platformsByBrand }: Props) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [brandId, setBrandId] = useState(brands[0]?.id ?? '')
  const [sourceType, setSourceType] = useState<GenerationSourceType>('topic')
  const [url, setUrl] = useState('')
  const [topic, setTopic] = useState('')
  const [hooks, setHooks] = useState('')
  const [webSearch, setWebSearch] = useState(false)
  const [focus, setFocus] = useState('')
  const [windowDays, setWindowDays] = useState(String(NEWS_WINDOW_DAYS.default))
  const [platforms, setPlatforms] = useState<Platform[]>(['x', 'linkedin-page', 'facebook', 'instagram'])
  const [count, setCount] = useState(5)
  const [templates, setTemplates] = useState<CardTemplate[]>(['dark', 'light', 'mint'])
  const [aiModel, setAiModel] = useState('')

  const available = useMemo(() => new Set(platformsByBrand[brandId] ?? []), [platformsByBrand, brandId])
  const missing = platforms.filter((p) => !available.has(p))
  // News always searches the web; a topic searches when asked.
  const research = sourceType === 'news' || (sourceType === 'topic' && webSearch)

  // Shown under the fields as soon as they are wrong, and again as a toast when the form is sent.
  const hooksProblem = sourceType === 'topic' ? hooksIssue(hooks) : null
  const noTemplate = templates.length === 0

  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value])

  function submit(e: React.FormEvent) {
    e.preventDefault()
    // Every click is a paid AI request: never send a second one while the first is in flight.
    if (pending) return
    const problem = validateGenerationState({ mode: sourceType, hooks, templates })
    if (problem) {
      toast.error(problem)
      return
    }
    start(async () => {
      try {
        const r = await createGenerationRequest(
          buildGenerationForm({ brandId, mode: sourceType, url, topic, hooks, focus, windowDays, webSearch, platforms, count, templates, aiModel })
        )
        if (!r.ok) {
          toast.error(r.error)
          return
        }
        toast.success('Cererea a fost trimisa generatorului.')
        setTopic('')
        setUrl('')
        setHooks('')
        setFocus('')
        router.refresh()
      } catch {
        toast.error('Cererea nu a putut fi trimisa. Incearca din nou.')
      }
    })
  }

  return (
    <form onSubmit={submit}>
      {/* Pending: the inputs lock too, not only the button, so nothing changes under a request in flight. */}
      <fieldset disabled={pending} className="min-w-0 space-y-5">
        <Field label="Brand">
          <select value={brandId} onChange={(e) => setBrandId(e.target.value)} className={inputClass}>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </Field>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold text-ink">Sursa</legend>
          <div className="flex flex-wrap gap-2">
            {GENERATION_SOURCE_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setSourceType(t)}
                aria-pressed={sourceType === t}
                className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${
                  sourceType === t ? 'border-accent bg-accent-soft text-accent-dark' : 'border-line-2 text-ink-soft hover:bg-bg-mint'
                }`}
              >
                {GENERATION_SOURCE_LABELS[t]}
              </button>
            ))}
          </div>
          {sourceType === 'article' ? (
            <Field label="Linkul articolului" hint="Cifrele vin doar din articol sau din lista de fapte verificate.">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://thecrypto.support/ghid/..."
                className={inputClass}
                required
              />
            </Field>
          ) : sourceType === 'news' ? (
            <>
              <Field label="Subiect (optional)" hint="Lasa gol pentru temele brandului. Altfel, cautarea se restrange la subiectul tau.">
                <input
                  value={focus}
                  onChange={(e) => setFocus(e.target.value)}
                  placeholder="Declaratia Unica, criptomonede, taxe"
                  className={inputClass}
                  maxLength={500}
                />
              </Field>
              <Field label="Perioada (zile)" hint={`Stiri din ultimele zile, intre ${NEWS_WINDOW_DAYS.min} si ${NEWS_WINDOW_DAYS.max}.`}>
                <input
                  type="number"
                  min={NEWS_WINDOW_DAYS.min}
                  max={NEWS_WINDOW_DAYS.max}
                  step={1}
                  value={windowDays}
                  onChange={(e) => setWindowDays(e.target.value)}
                  className={inputClass}
                  required
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Subiect">
                <input
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="Declaratia Unica: termenul de 25 mai"
                  className={inputClass}
                  required
                  minLength={3}
                />
              </Field>
              <Field
                label="Unghiuri (optional)"
                hint={`Separate prin virgula, de exemplu: termen, schimbare de cota. Cel mult ${HOOKS_MAX.items}, fiecare de cel mult ${HOOKS_MAX.length} de caractere.`}
                error={hooksProblem}
              >
                <input value={hooks} onChange={(e) => setHooks(e.target.value)} className={inputClass} aria-invalid={hooksProblem ? true : undefined} />
              </Field>
              <label className="flex items-center gap-2 text-sm font-semibold text-ink">
                <input type="checkbox" checked={webSearch} onChange={(e) => setWebSearch(e.target.checked)} />
                Cauta pe web date actuale
              </label>
            </>
          )}
          {research ? (
            <div role="note" className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-warn">
              <p className="font-semibold">{RESEARCH_COST_NOTE}</p>
              <p className="mt-0.5">Sursele gasite apar pe ciorna si trebuie bifate ca verificate inainte de aprobare.</p>
            </div>
          ) : null}
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-ink">Platforme</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {PLATFORMS.map((p) => (
              <label
                key={p}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                  platforms.includes(p) ? 'border-accent bg-accent-soft text-accent-dark' : 'border-line-2 text-ink-soft'
                }`}
              >
                <input type="checkbox" checked={platforms.includes(p)} onChange={() => setPlatforms(toggle(platforms, p))} />
                {PLATFORM_LABELS[p]}
              </label>
            ))}
          </div>
          {missing.length ? (
            <p className="mt-2 text-xs text-warn">
              Brandul nu are cont pentru {missing.map((p) => PLATFORM_LABELS[p]).join(', ')}. Variantele pentru ele se pastreaza in
              ciorna, dar nu devin destinatii pana nu adaugi contul.
            </p>
          ) : null}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Cate ciorne" hint="Intre 1 si 20.">
            <input
              type="number"
              min={1}
              max={20}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className={inputClass}
            />
          </Field>
          <fieldset>
            <legend className="mb-1.5 text-sm font-semibold text-ink">Sabloane de card</legend>
            <div className="flex gap-2">
              {CARD_TEMPLATES.map((t) => (
                <label key={t} className="flex items-center gap-1.5 text-sm text-ink">
                  <input type="checkbox" checked={templates.includes(t)} onChange={() => setTemplates(toggle(templates, t))} />
                  {CARD_TEMPLATE_LABELS[t]}
                </label>
              ))}
            </div>
            {noTemplate ? (
              <p role="alert" className="mt-1.5 text-xs font-semibold text-danger">
                {NO_TEMPLATE_MESSAGE}
              </p>
            ) : null}
          </fieldset>
        </div>

        <Field
          label="Model AI"
          hint="Implicit foloseste setarea din .env-ul worker-ului. Worker-ul are nevoie de cheia furnizorului ales; fara ea, cererea esueaza cu AI_NOT_CONFIGURED."
        >
          <select value={aiModel} onChange={(e) => setAiModel(e.target.value)} className={inputClass}>
            <option value="">Implicit (setarea worker-ului)</option>
            {AI_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>

        <div className="flex items-center justify-end gap-3">
          {research ? <span className="text-xs text-ink-soft">Cu cautare pe web</span> : null}
          <Button type="submit" disabled={pending || !brandId || platforms.length === 0}>
            {pending ? 'Se trimite...' : 'Genereaza ciornele'}
          </Button>
        </div>
      </fieldset>
    </form>
  )
}
