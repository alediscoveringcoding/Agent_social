'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { deleteMedia, updateMediaAlt } from '@/lib/social/media-actions'
import type { MediaItem } from '@/lib/social/media-queries'
import { Badge, Button, Card, Field, inputClass } from '@/components/ui'

function MediaTile({ item }: { item: MediaItem }) {
  const [alt, setAlt] = useState(item.alt_text)
  const [pending, start] = useTransition()
  const router = useRouter()
  function run(remove: boolean) {
    start(async () => {
      const result = remove ? await deleteMedia(item.id) : await updateMediaAlt({ mediaId: item.id, altText: alt })
      if (!result.ok) toast.error(result.error)
      else { toast.success(remove ? 'Imagine stearsa.' : 'Text alternativ salvat.'); router.refresh() }
    })
  }
  return <Card>
    {item.url ? <img src={item.url} alt={item.alt_text} className="mb-3 max-h-64 w-full rounded-lg object-contain" /> : null /* eslint-disable-line @next/next/no-img-element */}
    <div className="mb-3 flex flex-wrap gap-2"><Badge>{item.source === 'generated' ? 'Card' : 'Imagine'}</Badge><span className="text-xs text-ink-soft">{item.width} × {item.height} · {Math.ceil(item.bytes / 1024)} KB</span>{item.attached ? <Badge tone="accent">Atasata</Badge> : null}</div>
    <Field label="Text alternativ sugerat" hint="Reviziile existente pastreaza propriul text. Modifica textul atasat din ciorna."><textarea className={inputClass} value={alt} maxLength={1000} onChange={(e) => setAlt(e.target.value)} disabled={pending} /></Field>
    <div className="mt-3 flex gap-2"><Button tone="secondary" disabled={pending || !alt.trim() || alt === item.alt_text} onClick={() => run(false)}>Salveaza textul</Button><Button tone="danger" disabled={pending || item.attached} onClick={() => run(true)}>Sterge</Button></div>
  </Card>
}
export function MediaLibrary({ items }: { items: MediaItem[] }) {
  return <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{items.map((item) => <MediaTile key={`${item.id}:${item.alt_text}`} item={item} />)}</div>
}
