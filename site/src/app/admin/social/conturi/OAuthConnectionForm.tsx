'use client'
import { useTransition, type FormEvent } from 'react'
import { toast } from 'sonner'
import { Button, Card, Field, inputClass } from '@/components/ui'
import type { AdminBrand } from '@/lib/social/accounts-queries'
import { startNativeOAuth } from '@/lib/native/oauth-actions'
import type { OAuthPlatform } from '@/lib/native/oauth-config'

const choices: Array<{ value: OAuthPlatform; label: string }> = [
  { value: 'instagram', label: 'Instagram (Business / Creator)' }, { value: 'facebook', label: 'Facebook Pages' },
  { value: 'x', label: 'X' }, { value: 'linkedin', label: 'LinkedIn (profil)' }, { value: 'linkedin-page', label: 'LinkedIn (pagina)' },
  { value: 'tiktok', label: 'TikTok' }, { value: 'youtube', label: 'YouTube' },
]
export function OAuthConnectionForm({ brands }: { brands: AdminBrand[] }) {
  const [pending, start] = useTransition()
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    start(async () => {
      const result = await startNativeOAuth({ platform: String(form.get('platform')) as OAuthPlatform, brandId: String(form.get('brand')) })
      if (!result.ok) { toast.error(result.error); return }
      window.location.assign(result.url)
    })
  }
  return <Card><h2 className="mb-2 font-bold">Autorizeaza un cont existent</h2>
    <p className="mb-4 text-sm text-ink-soft">Te autentifici pe site-ul platformei si permiti publicarea. Dupa autorizare alegi profilul, pagina sau canalul.</p>
    <form onSubmit={submit}><fieldset disabled={pending} className="grid gap-3 md:grid-cols-2">
      <Field label="Platforma"><select name="platform" className={inputClass}>{choices.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field>
      <Field label="Brand"><select name="brand" className={inputClass} required defaultValue=""><option value="" disabled>Alege brandul</option>{brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</select></Field>
      <div className="md:col-span-2"><Button type="submit" disabled={!brands.length}>{pending ? 'Se pregateste autorizarea...' : 'Continua pe platforma'}</Button></div>
    </fieldset></form>
  </Card>
}
