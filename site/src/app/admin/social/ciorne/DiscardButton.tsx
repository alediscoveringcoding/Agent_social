'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { discardDraft } from '@/lib/social/actions'
import { Button } from '@/components/ui'

export function DiscardButton({ postId, title, redirectTo }: { postId: string; title: string | null; redirectTo?: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  function onClick() {
    if (!window.confirm(`Renunti la ciorna "${title || 'fara titlu'}"? Ramane in istoric, dar nu mai apare in inbox.`)) return
    start(async () => {
      const r = await discardDraft(postId)
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      toast.success('Ciorna a fost renuntata.')
      if (redirectTo) router.push(redirectTo)
      else router.refresh()
    })
  }
  return (
    <Button tone="danger" onClick={onClick} disabled={pending} className="px-3 py-1.5">
      {pending ? 'Se renunta...' : 'Renunta'}
    </Button>
  )
}
