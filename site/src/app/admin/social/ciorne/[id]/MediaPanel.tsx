'use client'
import Link from 'next/link'
import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { setDestinationMedia } from '@/lib/social/media-actions'
import type { MediaItem } from '@/lib/social/media-queries'
import type { DraftDetail } from '@/lib/social/queries'
import { Button, Card, Field, inputClass } from '@/components/ui'

export function MediaPanel({ draft, accountId, items, disabled, dirty, onBusyChange, onSelectionDirtyChange }: { draft: DraftDetail; accountId: string; items: MediaItem[]; disabled: boolean; dirty: boolean; onBusyChange: (busy: boolean) => void; onSelectionDirtyChange: (dirty: boolean) => void }) {
  const attached = draft.destinations.find((d) => d.account_id === accountId)?.media ?? []
  const [selection, setSelection] = useState(attached.map((m) => ({ mediaId: m.media_id, altText: m.alt_text })))
  const selectionDirty = JSON.stringify(selection) !== JSON.stringify(attached.map((m) => ({ mediaId: m.media_id, altText: m.alt_text })))
  useEffect(() => { onSelectionDirtyChange(selectionDirty) }, [selectionDirty, onSelectionDirtyChange])
  useEffect(() => () => onSelectionDirtyChange(false), [onSelectionDirtyChange])
  const [pending, start] = useTransition()
  useEffect(() => { onBusyChange(pending) }, [pending, onBusyChange])
  useEffect(() => () => onBusyChange(false), [onBusyChange])
  const router = useRouter()
  const allowed = new Map([...items.map((m) => [m.id, { id: m.id, alt_text: m.alt_text, url: m.url }] as const), ...attached.map((m) => [m.media_id, { id: m.media_id, alt_text: m.alt_text, url: m.url }] as const)])
  function save() {
    onBusyChange(true)
    start(async () => {
      try {
        const result = await setDestinationMedia({ postId: draft.id, baseRevisionId: draft.revision.id, accountId, media: selection })
        if (!result.ok) toast.error(result.error)
        else { toast.success('Imagini salvate ca revizie noua.'); router.refresh() }
      } catch { toast.error('Salvarea a esuat. Incearca din nou.') }
    })
  }
  return <Card><h2 className="text-sm font-bold text-ink">Imagini pentru destinatie</h2><p className="mt-1 text-xs text-ink-soft">Ordinea selectiei este ordinea publicarii. <Link href="/admin/social/media" className="text-accent-dark underline">Incarca o imagine</Link></p>
    {dirty ? <p className="mt-2 text-xs text-warn">Salveaza textul inainte de a atasa imagini.</p> : null}
    <div className="mt-3 max-h-64 space-y-2 overflow-auto">{[...allowed.values()].map((item) => <label key={item.id} className="flex items-center gap-2 rounded border border-line p-2 text-xs"><input type="checkbox" disabled={disabled || dirty || pending} checked={selection.some((m) => m.mediaId === item.id)} onChange={(e) => setSelection(e.target.checked ? [...selection, { mediaId: item.id, altText: item.alt_text }] : selection.filter((m) => m.mediaId !== item.id))} />{item.url ? <img src={item.url} alt={item.alt_text} className="h-12 w-16 rounded object-contain" /> : null /* eslint-disable-line @next/next/no-img-element */}<span>{item.alt_text}</span></label>)}</div>
    <div className="mt-3 space-y-2">{selection.map((m, i) => <Field key={m.mediaId} label={`Text alternativ ${i + 1}`}><textarea disabled={disabled || dirty || pending} value={m.altText} maxLength={1000} className={inputClass} onChange={(e) => setSelection(selection.map((item) => item.mediaId === m.mediaId ? { ...item, altText: e.target.value } : item))} /></Field>)}</div>
    {selectionDirty ? <p className="mt-2 text-xs text-warn">Selectie de imagini nesalvata.</p> : null}
    <div className="mt-3 flex flex-wrap gap-2"><Button tone="secondary" disabled={disabled || dirty || pending || !selectionDirty || selection.some((m) => !m.altText.trim())} onClick={save}>Salveaza imaginile</Button><Button tone="ghost" disabled={disabled || pending || !selectionDirty} onClick={() => setSelection(attached.map((m) => ({ mediaId: m.media_id, altText: m.alt_text })))}>Restabileste selectia</Button></div>
  </Card>
}
