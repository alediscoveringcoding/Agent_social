'use client'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { getTikTokCreator } from '@/lib/native/creator-actions'
import { Field, inputClass } from '@/components/ui'
import { TIKTOK_PRIVACY_LABELS } from '@/lib/social/platform-settings'

export function TikTokCreator({ accountId, value, disabled, onChange }: { accountId: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const [info, setInfo] = useState<{ name: string; privacy: string[]; maxDuration: number } | null>(null)
  const [error, setError] = useState('')
  const request = useRef<ReturnType<typeof getTikTokCreator> | null>(null)
  useEffect(() => {
    let active = true
    const pending = request.current ??= getTikTokCreator(accountId)
    pending.then((result) => {
      if (!active) return
      if (result.ok) setInfo(result)
      else { setError(result.error); toast.error(result.error) }
    }).catch(() => { if (active) { setError('Verificarea contului TikTok a esuat.'); toast.error('Verificarea contului TikTok a esuat.') } })
    return () => { active = false }
  }, [accountId])
  return <div className="mb-3 space-y-2">
    <p className="text-sm text-ink-soft">{info ? `${info.name} · video pana la ${info.maxDuration} secunde` : error || 'Se verifica optiunile contului TikTok...'}</p>
    <Field label="Cine vede postarea"><select className={inputClass} disabled={disabled || !info} value={info?.privacy.includes(value) ? value : ''} onChange={(event) => onChange(event.target.value)}>
      <option value="">Alege vizibilitatea</option>{info?.privacy.map((privacy) => <option key={privacy} value={privacy}>{TIKTOK_PRIVACY_LABELS[privacy as keyof typeof TIKTOK_PRIVACY_LABELS] || privacy}</option>)}
    </select></Field>
    <p className="text-xs text-ink-soft">Prin acordul de publicare confirmi si <a className="underline" target="_blank" rel="noreferrer" href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en">confirmarea utilizarii muzicii</a>.</p>
  </div>
}
