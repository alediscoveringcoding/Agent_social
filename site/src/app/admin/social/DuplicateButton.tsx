'use client'
import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui'
import { duplicatePost } from '@/lib/social/handoff-actions'

export function DuplicateButton({ postId }: { postId: string }) {
  const [pending, start] = useTransition()
  const router = useRouter()
  return <Button tone="secondary" disabled={pending} onClick={() => start(async () => {
    const r = await duplicatePost(postId)
    if (!r.ok) { toast.error(r.error); return }
    toast.success(r.dropped ? `Ciorna copiata; ${r.dropped} conturi mutate au fost omise.` : 'Ciorna copiata.')
    router.push(`/admin/social/ciorne/${r.postId}`)
    router.refresh()
  })}>{pending ? 'Se copiaza...' : 'Duplica'}</Button>
}
