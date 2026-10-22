'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button, Card } from '@/components/ui'
import { selectNativeDestination } from '@/lib/native/candidate-actions'
import type { CandidateSummary } from '@/lib/native/candidates'

export function SelectDestination({ id, destinations }: { id: string; destinations: CandidateSummary[] }) {
  const [selected, setSelected] = useState(destinations.length === 1 ? destinations[0].index : -1)
  const [pending, start] = useTransition()
  const router = useRouter()
  return <Card><fieldset disabled={pending} className="space-y-3"><legend className="mb-3 font-bold">Conturi disponibile</legend>
    {destinations.map((item) => <label key={item.index} className="flex items-center gap-3 rounded border border-line p-3">
      <input type="radio" name="destination" checked={selected === item.index} onChange={() => setSelected(item.index)} />
      <span>{item.displayName}{item.profileUrl ? <span className="block text-xs text-ink-soft">{item.profileUrl}</span> : null}</span>
    </label>)}
    <Button disabled={selected < 0} onClick={() => start(async () => {
      const result = await selectNativeDestination({ id, index: selected })
      if (!result.ok) { toast.error(result.error); return }
      toast.success('Cont conectat. Verifica setarile si scoate-l de pe pauza cand esti pregatit.')
      router.push('/admin/social/conturi'); router.refresh()
    })}>{pending ? 'Se conecteaza...' : 'Conecteaza contul selectat'}</Button>
  </fieldset></Card>
}
