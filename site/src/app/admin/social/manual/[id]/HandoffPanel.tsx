'use client'
import { useState, useTransition, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button, Card, Field, inputClass } from '@/components/ui'
import type { ManualJobDetail } from '@/lib/social/handoff-queries'
import { markManualPublished } from '@/lib/social/handoff-actions'
import { downloadName, htmlDocument } from '@/lib/social/handoff'
import { isHttpUrl } from '@/lib/social/schemas'
import { formatBucharest } from '@/lib/social/time'

export function HandoffPanel({ detail: d }: { detail: ManualJobDetail }) {
  const [pending, start] = useTransition()
  const [checked, setChecked] = useState<string[]>([])
  const router = useRouter()
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast.success('Copiat.') } catch { toast.error('Nu am putut copia. Selecteaza textul si copiaza manual.') } }
  const download = (format: 'txt' | 'md' | 'html') => {
    const body = format === 'html' ? htmlDocument(d.job.post?.title ?? null, d.handoff.body.html) : format === 'md' ? d.handoff.body.markdown : d.handoff.body.plain
    const fields = d.handoff.fields.map((f) => `${f.label}: ${f.value}`).join('\n\n')
    const content = format === 'html' ? body : `${fields}${fields ? '\n\n' : ''}${body}\n`
    const url = URL.createObjectURL(new Blob([content], { type: format === 'html' ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = downloadName(d.job.post?.title ?? null, d.job.platform, format); anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const url = String(new FormData(event.currentTarget).get('url'))
    start(async () => { const r = await markManualPublished(d.job.id, url); if (!r.ok) toast.error(r.error); else toast.success(r.alreadyDone ? 'Publicarea era deja marcata.' : 'Publicare confirmata.'); router.refresh() })
  }
  const done = d.job.status === 'manual_done'
  return <div className="grid gap-5 lg:grid-cols-[2fr_1fr]"><div className="space-y-5"><Card><h2 className="mb-3 font-bold">Campuri pentru editor</h2>
    {!d.handoff.fields.length && <p className="text-sm text-ink-soft">Textul de mai jos este gata de copiat.</p>}
    {d.handoff.fields.map((f) => <div className="mb-4" key={f.key}><div className="mb-1 flex justify-between gap-2"><strong className="text-sm">{f.label}{f.max ? ` (${f.value.length}/${f.max})` : ''}</strong><Button tone="ghost" onClick={() => copy(f.value)}>Copiaza</Button></div><textarea aria-label={f.label} readOnly rows={f.multiline ? 4 : 2} className={inputClass} value={f.value} /></div>)}
    <h2 className="mb-2 font-bold">{d.handoff.body.label}</h2><div className="mb-3 flex flex-wrap gap-2"><Button tone="secondary" onClick={() => copy(d.handoff.body.plain)}>Copiaza text</Button><Button tone="secondary" onClick={() => copy(d.handoff.body.markdown)}>Copiaza markdown</Button><Button tone="secondary" onClick={() => copy(d.handoff.body.html)}>Copiaza HTML</Button></div>
    <textarea aria-label="Continut markdown" className={inputClass} readOnly rows={16} value={d.handoff.body.markdown} /><div className="mt-3 flex flex-wrap gap-2">{(['txt', 'md', 'html'] as const).map((f) => <Button key={f} tone="ghost" onClick={() => download(f)}>Descarca .{f}</Button>)}</div></Card>
    <Card><h2 className="mb-3 font-bold">Imagini</h2>{!d.media.length && <p className="text-sm text-ink-soft">Nicio imagine atasata.</p>}<ul className="space-y-3">{d.media.map((m) => <li key={m.media_id}><p className="text-sm">{m.alt_text} · {m.width} × {m.height}</p>{m.url && (m.url.startsWith('/api/media/') || isHttpUrl(m.url)) && <a className="text-sm font-semibold text-accent-dark" href={m.url} download={m.filename} target="_blank" rel="noreferrer">Deschide / descarca imaginea</a>}<Button tone="ghost" onClick={() => copy(m.alt_text)}>Copiaza text alternativ</Button></li>)}</ul></Card></div>
    <div className="space-y-5"><Card><h2 className="mb-3 font-bold">Publica pe platforma</h2>{d.account.open_editor_url && isHttpUrl(d.account.open_editor_url) && <a className="inline-block rounded-lg bg-primary px-3.5 py-2 text-sm font-bold text-on-primary" href={d.account.open_editor_url} target="_blank" rel="noreferrer">Deschide editorul ↗</a>}
      <p className="mt-3 text-sm text-ink-soft">Programata: {formatBucharest(d.job.run_at)}</p>{!d.due && <p className="mt-2 text-sm text-warn">Ora programata nu a sosit. Poti pregati continutul acum.</p>}
      <ul className="mt-4 space-y-3">{d.handoff.checklist.map((text) => <li key={text}><label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={checked.includes(text)} onChange={(e) => setChecked(e.target.checked ? [...checked, text] : checked.filter((x) => x !== text))} />{text}</label></li>)}</ul></Card>
      <Card>{done ? <><h2 className="font-bold">Publicare confirmata</h2>{d.job.remote_url && isHttpUrl(d.job.remote_url) && <a href={d.job.remote_url} target="_blank" rel="noreferrer" className="mt-2 block text-sm text-accent-dark">Vezi publicarea ↗</a>}<p className="mt-2 text-xs text-ink-soft">{d.job.manual_done_at && formatBucharest(d.job.manual_done_at)}{d.manual_done_by_email ? ` · ${d.manual_done_by_email}` : ''}</p></> : d.job.status === 'manual_pending' ? <form onSubmit={submit}><Field label="Link public"><input className={inputClass} type="url" name="url" required maxLength={2048} placeholder="https://..." /></Field><Button type="submit" className="mt-3" disabled={pending || checked.length !== d.handoff.checklist.length}>{pending ? 'Se confirma...' : 'Marcheaza ca publicat'}</Button><p className="mt-2 text-xs text-ink-soft">Bifeaza lista dupa ce ai publicat.</p></form> : <p className="text-sm text-warn">Destinatia nu mai asteapta publicarea manuala.</p>}</Card></div></div>
}
