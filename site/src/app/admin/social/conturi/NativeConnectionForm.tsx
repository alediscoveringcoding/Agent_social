'use client'
import { useState, useTransition, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button, Card, Field, inputClass } from '@/components/ui'
import type { AdminBrand } from '@/lib/social/accounts-queries'
import { CONNECTION_FORMS, type CredentialPlatform } from '@/lib/native/connections-catalog'
import { connectNativeAccount } from '@/lib/native/connection-actions'

export function NativeConnectionForm({ brands }: { brands: AdminBrand[] }) {
  const [platform, setPlatform] = useState<CredentialPlatform>('bluesky')
  const [pending, start] = useTransition()
  const router = useRouter()
  const config = CONNECTION_FORMS.find((item) => item.platform === platform)!
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const element = event.currentTarget
    const data = new FormData(element)
    start(async () => {
      const result = await connectNativeAccount({ platform, brandId: String(data.get('brand')),
        secrets: Object.fromEntries(config.fields.map((field) => [field.key, String(data.get(field.key) || '')])),
        instanceUrl: String(data.get('instance') || ''), destinationId: String(data.get('destination') || ''),
      })
      if (!result.ok) { toast.error(result.error); return }
      element.reset()
      toast.success('Cont conectat. Verifica setarile si scoate-l de pe pauza cand esti pregatit.')
      router.refresh()
    })
  }
  return <Card><h2 className="mb-2 font-bold">Conecteaza un cont existent</h2>
    <p className="mb-4 text-sm text-ink-soft">Conectare directa in aplicatie. Conturile noi pornesc pe pauza.</p>
    <form onSubmit={submit} autoComplete="off"><fieldset disabled={pending} className="grid gap-3 md:grid-cols-2">
      <Field label="Platforma"><select className={inputClass} value={platform} onChange={(event) => setPlatform(event.target.value as CredentialPlatform)}>
        {CONNECTION_FORMS.map((item) => <option key={item.platform} value={item.platform}>{item.label}</option>)}
      </select></Field>
      <Field label="Brand"><select className={inputClass} name="brand" required defaultValue=""><option value="" disabled>Alege brandul</option>{brands.map((brand) => <option key={brand.id} value={brand.id}>{brand.name}</option>)}</select></Field>
      <p className="text-sm text-ink-soft md:col-span-2" role="note">{config.help}</p>
      {config.fields.map((field) => <Field key={`${platform}:${field.key}`} label={field.label}>
        <input className={inputClass} name={field.key} type={field.secret ? 'password' : 'text'} required maxLength={32768} autoComplete={field.secret ? 'new-password' : 'off'} spellCheck={false} />
      </Field>)}
      {config.instance && <Field label="Adresa instantei" hint="Gol pentru bsky.social. Pentru alt server: adresa HTTPS."><input className={inputClass} name="instance" type="url" placeholder="https://bsky.social" maxLength={2048} /></Field>}
      {config.destination && <Field label="Canal sau chat" hint="De exemplu @canal_exemplu sau ID-ul numeric al chatului."><input className={inputClass} name="destination" required maxLength={512} /></Field>}
      <div className="md:col-span-2"><Button type="submit" disabled={!brands.length}>{pending ? 'Se verifica accesul...' : 'Conecteaza contul'}</Button></div>
    </fieldset></form>
  </Card>
}
