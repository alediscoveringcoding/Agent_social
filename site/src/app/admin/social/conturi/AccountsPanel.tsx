'use client'
import { useState, useTransition, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge, Button, Card, Field, inputClass } from '@/components/ui'
import { ACCOUNT_STATUS_LABELS, PLATFORMS, PLATFORM_LABELS, type AccountStatus, type Platform } from '@/lib/social/constants'
import { ACCOUNT_STATUS_HINTS, ACCOUNT_STATUS_TONES, STATUSES_FOR_MODE, ago, isManualOnlyPlatform, publishBlockers, type AccountMode } from '@/lib/social/accounts'
import type { AdminAccount, AdminBrand } from '@/lib/social/accounts-queries'
import { createManualAccount, deleteManualAccount, updateAccount } from '@/lib/social/accounts-actions'
import { isHttpUrl } from '@/lib/social/schemas'

function AccountRow({ account: a, brands, now }: { account: AdminAccount; brands: AdminBrand[]; now: string }) {
  const [mode, setMode] = useState<AccountMode>(a.mode)
  const [status, setStatus] = useState<AccountStatus>(a.status)
  const [brand, setBrand] = useState(a.brand_id ?? '')
  const [paused, setPaused] = useState(a.paused)
  const [pending, start] = useTransition()
  const router = useRouter()
  const manualOnly = !a.postiz_integration_id
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    start(async () => {
      const r = await updateAccount(a.id, { brand_id: brand || null, mode, status, daily_cap: Number(form.get('cap')), paused,
        open_editor_url: String(form.get('editor') ?? ''), ...(manualOnly ? { display_name: String(form.get('name')), profile_url: String(form.get('profile') ?? '') } : {}) })
      if (!r.ok) toast.error(r.error)
      else toast.success(r.changed.length ? 'Cont salvat.' : 'Nicio schimbare.')
      router.refresh()
    })
  }
  return <tr className="border-t border-line align-top"><td className="p-3 text-sm"><div className="flex items-center gap-2">
    {a.picture_url && isHttpUrl(a.picture_url) && <a href={a.picture_url} target="_blank" rel="noreferrer" className="text-xs text-accent-dark">Imagine ↗</a>}
    <strong>{a.display_name}</strong></div><p>{PLATFORM_LABELS[a.platform]}</p><p className="mt-1 text-xs text-ink-soft">{a.postiz_integration_id ? `Postiz: ${a.postiz_integration_id}` : 'Cont manual'} · sync {ago(a.last_synced_at, new Date(now))}</p>
    <div className="mt-2"><Badge tone={ACCOUNT_STATUS_TONES[a.status]}>{ACCOUNT_STATUS_LABELS[a.status]}</Badge></div><p className="mt-1 max-w-xs text-xs text-ink-soft">{ACCOUNT_STATUS_HINTS[a.status]}</p>
    <p className="mt-1 text-xs text-warn">{publishBlockers(a).join(' · ')}</p><p className="mt-1 text-xs">{a.open_jobs} destinatii in lucru</p>
    {a.profile_url && isHttpUrl(a.profile_url) && <a href={a.profile_url} target="_blank" rel="noreferrer" className="mr-3 text-xs text-accent-dark">Profil ↗</a>}
    {a.open_editor_url && isHttpUrl(a.open_editor_url) && <a href={a.open_editor_url} target="_blank" rel="noreferrer" className="text-xs text-accent-dark">Deschide editorul ↗</a>}</td>
    <td className="min-w-[32rem] p-3"><form onSubmit={submit}><fieldset disabled={pending} className="grid gap-3 sm:grid-cols-3">
      <Field label="Brand"><select className={inputClass} value={brand} onChange={(e) => { setBrand(e.target.value); if (!e.target.value) setPaused(true) }}><option value="">Atribuie un brand</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
      <Field label="Mod"><select className={inputClass} value={mode} onChange={(e) => { const next = e.target.value as AccountMode; setMode(next); setStatus(next === 'manual' ? 'manual' : 'connected') }}><option value="manual">Manual</option><option value="auto" disabled={manualOnly || isManualOnlyPlatform(a.platform)}>Automat</option></select></Field>
      <Field label="Stare"><select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value as AccountStatus)}>{STATUSES_FOR_MODE[mode].map((s) => <option value={s} key={s}>{ACCOUNT_STATUS_LABELS[s]}</option>)}</select></Field>
      <Field label="Limita zilnica"><input className={inputClass} type="number" name="cap" min={1} max={5} required defaultValue={a.daily_cap} /></Field>
      <Field label="Link editor"><input className={inputClass} name="editor" type="url" maxLength={2048} defaultValue={a.open_editor_url ?? ''} /></Field>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={paused} disabled={!brand} onChange={(e) => setPaused(e.target.checked)} /> Pe pauza</label>
      {manualOnly && <><Field label="Nume"><input className={inputClass} name="name" required maxLength={120} defaultValue={a.display_name} /></Field><Field label="Profil"><input className={inputClass} name="profile" type="url" maxLength={2048} defaultValue={a.profile_url ?? ''} /></Field></>}
      <div className="flex items-end gap-2"><Button type="submit">{pending ? 'Se salveaza...' : 'Salveaza'}</Button>{manualOnly && !a.used && <Button tone="danger" onClick={() => {
        if (!window.confirm(`Stergi contul ${a.display_name}?`)) return
        start(async () => { const r = await deleteManualAccount(a.id); if (!r.ok) toast.error(r.error); else toast.success('Cont sters.'); router.refresh() })
      }}>Sterge</Button>}</div></fieldset></form></td></tr>
}

export function AccountsPanel({ accounts, brands, now }: { accounts: AdminAccount[]; brands: AdminBrand[]; now: string }) {
  const [pending, start] = useTransition()
  const router = useRouter()
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    start(async () => {
      const r = await createManualAccount({ platform: String(form.get('platform')) as Platform, brandId: String(form.get('brand')), displayName: String(form.get('name')), openEditorUrl: String(form.get('editor')), profileUrl: String(form.get('profile')), dailyCap: Number(form.get('cap')) })
      if (!r.ok) toast.error(r.error)
      else { toast.success('Cont manual creat.'); formElement.reset() }
      router.refresh()
    })
  }
  const sorted = [...accounts].sort((a, b) => Number(!!a.brand_id) - Number(!!b.brand_id))
  return <div className="space-y-5"><Card><h2 className="mb-3 font-bold">Cont nou pentru publicare manuala</h2><form onSubmit={create}><fieldset disabled={pending} className="grid gap-3 md:grid-cols-3">
    <Field label="Platforma"><select className={inputClass} name="platform" defaultValue="substack">{PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}</select></Field>
    <Field label="Brand"><select className={inputClass} name="brand" required defaultValue=""><option value="" disabled>Alege brandul</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
    <Field label="Nume" hint="Pentru Forum si Presa: numele forumului sau al publicatiei (un cont pe forum sau redactie)."><input className={inputClass} name="name" required maxLength={120} /></Field>
    <Field label="Link editor" hint="Gol: editorul implicit al platformei. La Forum si Presa: pagina forumului sau de contact a redactiei (https)."><input className={inputClass} name="editor" type="url" maxLength={2048} /></Field>
    <Field label="Profil"><input className={inputClass} name="profile" type="url" maxLength={2048} /></Field>
    <Field label="Limita zilnica"><input className={inputClass} name="cap" type="number" min={1} max={5} defaultValue={5} required /></Field>
    <Button type="submit" disabled={!brands.length}>Creeaza cont manual</Button></fieldset></form></Card>
    <div className="overflow-x-auto rounded-card border border-line bg-card"><table className="w-full text-left"><caption className="p-3 text-left text-sm text-ink-soft">Conturile fara brand apar primele si raman pe pauza pana la atribuire.</caption><thead><tr><th className="p-3">Cont</th><th className="p-3">Configurare</th></tr></thead><tbody>{sorted.map((a) => <AccountRow key={`${a.id}:${a.updated_at}`} account={a} brands={brands} now={now} />)}</tbody></table>{!accounts.length && <p className="p-4 text-sm text-ink-soft">Niciun cont. Ruleaza sincronizarea workerului sau creeaza un cont manual.</p>}</div></div>
}
