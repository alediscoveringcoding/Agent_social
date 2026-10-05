'use client'
import Link from 'next/link'
import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge, Button, Card } from '@/components/ui'
import { EVENT_LABELS } from '@/lib/social/constants'
import type { OverviewEvent } from '@/lib/social/overview-queries'
import { markEventsSeen } from '@/lib/social/overview-actions'
import { formatBucharest } from '@/lib/social/time'

export function EventFeed({ events, unseen }: { events: OverviewEvent[]; unseen: number }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const mark = (input: { ids?: number[]; upTo?: number }) => start(async () => {
    const r = await markEventsSeen(input)
    if (!r.ok) toast.error(r.error)
    else toast.success(`${r.marked} evenimente marcate.`)
    router.refresh()
  })
  return <Card><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold">Evenimente <Badge>{unseen} necitite</Badge></h2>
    <div className="flex gap-3"><Link className="text-sm text-accent-dark" href="/admin/social?seen=1">Arata si citite</Link><Button tone="secondary" disabled={pending || !events.some((e) => !e.seen_at)} onClick={() => mark({ upTo: Math.max(...events.map((e) => e.id)) })}>Marcheaza lista ca vazuta</Button></div></div>
    {!events.length && <p className="mt-3 text-sm text-ink-soft">Niciun eveniment nou.</p>}
    <ul className="mt-3 divide-y divide-line">{events.map((e) => {
      const postId = typeof e.payload.post_id === 'string' && /^[0-9a-f-]{36}$/i.test(e.payload.post_id) ? e.payload.post_id : null
      return <li className="flex flex-wrap items-start justify-between gap-2 py-3" key={e.id}><div><p className="font-semibold">{EVENT_LABELS[e.type]}</p><p className="text-xs text-ink-soft">{formatBucharest(e.created_at)}</p>
        {postId && <Link className="text-sm text-accent-dark hover:underline" href={`/admin/social/postari/${postId}`}>Deschide postarea</Link>}
        {typeof e.payload.error_message === 'string' && <p className="text-sm text-danger">{e.payload.error_message}</p>}</div>
        {e.seen_at ? <Badge>Vazut</Badge> : <Button tone="ghost" disabled={pending} onClick={() => mark({ ids: [e.id] })}>Marcheaza ca vazut</Button>}</li>
    })}</ul></Card>
}
