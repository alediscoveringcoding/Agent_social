'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createGenerationRequest } from '@/lib/social/actions'
import { AI_MODELS, CARD_TEMPLATES, CARD_TEMPLATE_LABELS, PLATFORMS, PLATFORM_LABELS, type CardTemplate, type Platform } from '@/lib/social/constants'
import { Button, Field, inputClass } from '@/components/ui'

interface Props {
  brands: Array<{ id: string; slug: string; name: string }>
  platformsByBrand: Record<string, Platform[]>
}

export function GenerateForm({ brands, platformsByBrand }: Props) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [brandId, setBrandId] = useState(brands[0]?.id ?? '')
  const [sourceType, setSourceType] = useState<'topic' | 'article'>('topic')
  const [url, setUrl] = useState('')
  const [topic, setTopic] = useState('')
  const [hooks, setHooks] = useState('')
  const [platforms, setPlatforms] = useState<Platform[]>(['x', 'linkedin-page', 'facebook', 'instagram'])
  const [count, setCount] = useState(5)
  const [templates, setTemplates] = useState<CardTemplate[]>(['dark', 'light', 'mint'])
  const [aiModel, setAiModel] = useState('')

  const available = useMemo(() => new Set(platformsByBrand[brandId] ?? []), [platformsByBrand, brandId])
  const missing = platforms.filter((p) => !available.has(p))

  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value])

  function submit(e: React.FormEvent) {
    e.preventDefault()
    start(async () => {
      const r = await createGenerationRequest({
        brandId,
        source:
          sourceType === 'article'
            ? { type: 'article', url: url.trim() }
            : { type: 'topic', topic: topic.trim(), hooks: hooks.split(',').map((h) => h.trim()).filter(Boolean) },
        platforms,
        count,
        templates,
        aiModel,
      })
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      toast.success('Cererea a fost trimisa generatorului.')
      setTopic('')
      setUrl('')
      setHooks('')
      router.refresh()
    })
  }

  return (
    <form onSubmit={submit} className="space-y-5">
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
        <div className="flex gap-2">
          {(['topic', 'article'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setSourceType(t)}
              className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${
                sourceType === t ? 'border-accent bg-accent-soft text-accent-dark' : 'border-line-2 text-ink-soft hover:bg-bg-mint'
              }`}
            >
              {t === 'topic' ? 'Subiect' : 'Articol de pe blog'}
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
            <Field label="Unghiuri (optional)" hint="Separate prin virgula, de exemplu: termen, schimbare de cota.">
              <input value={hooks} onChange={(e) => setHooks(e.target.value)} className={inputClass} />
            </Field>
          </>
        )}
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

      <div className="flex justify-end">
        <Button type="submit" disabled={pending || !brandId || platforms.length === 0}>
          {pending ? 'Se trimite...' : 'Genereaza ciornele'}
        </Button>
      </div>
    </form>
  )
}
