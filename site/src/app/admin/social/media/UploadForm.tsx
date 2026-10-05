'use client'
import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createUploadTicket, finalizeUpload } from '@/lib/social/media-actions'
import { Button, Field, inputClass } from '@/components/ui'

export function UploadForm() {
  const [file, setFile] = useState<File | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [alt, setAlt] = useState('')
  const [pending, start] = useTransition()
  const router = useRouter()
  function upload() {
    if (!file) return
    start(async () => {
      try {
        const ticket = await createUploadTicket({ mime: file.type, bytes: file.size })
        if (!ticket.ok) { toast.error(ticket.error); return }
        const response = await fetch(ticket.url, { method: ticket.method, body: file, headers: { 'Content-Type': file.type }, credentials: ticket.url.startsWith('/') ? 'same-origin' : 'omit' })
        if (!response.ok) throw new Error('Incarcarea a esuat. Verifica formatul si limita de 8 MB.')
        const result = await finalizeUpload({ ticket: ticket.ticket, altText: alt })
        if (!result.ok) { toast.error(result.error); return }
        setFile(null); setAlt(''); if (fileInput.current) fileInput.current.value = ''
        toast.success('Imagine incarcata.'); router.refresh()
      } catch (e) { toast.error(e instanceof Error ? e.message : 'Incarcarea a esuat.') }
    })
  }
  return <div className="space-y-3">
    <Field label="Imagine" hint="JPEG, PNG sau WebP, cel mult 8 MB. Metadatele sunt eliminate."><input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" disabled={pending} className={inputClass} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
    <Field label="Text alternativ" hint="Descrie ce se vede in imagine."><textarea className={inputClass} value={alt} maxLength={1000} disabled={pending} onChange={(e) => setAlt(e.target.value)} /></Field>
    <Button disabled={pending || !file || !alt.trim()} onClick={upload}>{pending ? 'Se incarca...' : 'Incarca imaginea'}</Button>
  </div>
}
