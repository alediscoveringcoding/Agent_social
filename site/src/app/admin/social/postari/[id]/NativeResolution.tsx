'use client'
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button, Card, Field, inputClass } from '@/components/ui'
import { resolveLegacyJob, resolveNativePublication } from '@/lib/native/resolution-actions'

/** `legacy`: a job of an old Postiz account (amendment 10), which nothing can look up any more. */
export function NativeResolution({ jobs }: { jobs: Array<{ id: string; name: string; legacy?: boolean }> }) {
  const [jobId, setJobId] = useState(jobs[0]?.id || '')
  const [found, setFound] = useState('')
  const [url, setUrl] = useState('')
  const [note, setNote] = useState('')
  const [pending, start] = useTransition()
  const router = useRouter()
  if (!jobs.length) return null
  const legacy = Boolean(jobs.find((job) => job.id === jobId)?.legacy)
  return <Card><h2 className="mb-2 font-bold">Verifica rezultatul pe platforma</h2>
    <p className="mb-3 text-sm text-ink-soft">{legacy
      ? 'Postarea a fost trimisa prin vechea conexiune Postiz, care nu mai exista. Verifica pe platforma si inregistreaza ce ai gasit.'
      : 'Trimiterea incerta nu se repeta automat. Poti inregistra postarea gasita sau, dupa 30 de minute, confirma absenta ei pe platforma.'}</p>
    <fieldset disabled={pending} className="grid gap-3 sm:grid-cols-2">
      <Field label="Destinatie"><select className={inputClass} value={jobId} onChange={(event) => setJobId(event.target.value)}>{jobs.map((job) => <option key={job.id} value={job.id}>{job.name}</option>)}</select></Field>
      <Field label="Rezultat verificat"><select className={inputClass} value={found} onChange={(event) => setFound(event.target.value)}><option value="">Alege dupa verificarea pe platforma</option><option value="yes">Am gasit postarea</option><option value="no">Am verificat: postarea nu exista</option></select></Field>
      {found === 'yes' ? <Field label="Linkul postarii"><input className={inputClass} type="url" value={url} onChange={(event) => setUrl(event.target.value)} /></Field> : null}
      <Field label="Ce ai verificat"><textarea className={inputClass} value={note} maxLength={1000} onChange={(event) => setNote(event.target.value)} /></Field>
      <div className="sm:col-span-2"><Button disabled={!found || note.trim().length < 5 || (found === 'yes' && !url)} onClick={() => start(async () => {
        const input = { jobId, found: found === 'yes', remoteUrl: url, note }
        const result = legacy ? await resolveLegacyJob(input) : await resolveNativePublication(input)
        if (!result.ok) { toast.error(result.error); return }
        toast.success('Rezultat inregistrat.'); router.refresh()
      })}>{pending ? 'Se inregistreaza...' : 'Inregistreaza verificarea'}</Button></div>
    </fieldset></Card>
}
