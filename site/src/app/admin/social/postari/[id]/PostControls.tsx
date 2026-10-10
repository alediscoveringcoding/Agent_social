'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge, Button, Card, Field, inputClass } from '@/components/ui'
import type { PostDetail, PostJob } from '@/lib/social/approval-queries'
import type { ApprovalResult } from '@/lib/social/approval-actions'
import type { DestinationIssues, LocalTime } from '@/lib/social/approval'
import { approvePost, cancelDestination, cancelPost, reopenForEdit, reschedulePost, retryFailed, suggestTimes } from '@/lib/social/approval-actions'
import { PLATFORM_LABELS } from '@/lib/social/constants'
import { isHttpUrl } from '@/lib/social/schemas'
import { formatBucharest, toLocalInputs } from '@/lib/social/time'
import { StatusChip } from '../StatusChip'
import { halfFilledTime } from '../../ciorne/[id]/ui-helpers'

const movable = new Set(['queued', 'claimed', 'manual_pending', 'failed'])
const cancellable = new Set(['queued', 'claimed', 'manual_pending'])
export function PostControls({ post }: { post: PostDetail }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [times, setTimes] = useState<Record<string, LocalTime>>(() => Object.fromEntries(post.destinations.map((d) => [d.account_id, d.scheduled_at ? toLocalInputs(d.scheduled_at) : { date: '', time: '' }])))
  const [slots, setSlots] = useState('09:00, 13:00, 18:00')
  const [figuresChecked, setFiguresChecked] = useState(false)
  const [reconcileChecked, setReconcileChecked] = useState(false)
  const [issues, setIssues] = useState<DestinationIssues[]>([])
  const [error, setError] = useState<string | null>(null)
  const editable = !post.cancelled_at && post.destinations.some((d) => !d.job || movable.has(d.job.status))
  const failed = post.destinations.filter((d) => d.job?.status === 'failed')
  const needsReconcile = failed.some((d) => d.job?.last_error_code === 'RECONCILE_MISS')
  const halfTime = post.destinations.some((d) => halfFilledTime(times[d.account_id]))
  const jobs = [...post.destinations.flatMap((d) => d.job ? [d.job] : []), ...post.earlierJobs]

  function run(action: () => Promise<ApprovalResult>, message: string | ((result: ApprovalResult) => string | null), redirect?: string) {
    setError(null); setIssues([])
    startTransition(async () => {
      try {
        const result = await action()
        if (!result.ok) { setError(result.error); setIssues(result.issues ?? []); toast.error(result.error) }
        else { const text = typeof message === 'function' ? message(result) : message; if (text) toast.success(text); if (redirect) router.push(redirect) }
      } catch { setError('Ceva nu a mers. Reincarca pagina si incearca din nou.'); toast.error('Actiunea nu a putut fi terminata.') }
      // Approve can save a revision before its final transaction fails.
      finally { router.refresh() }
    })
  }
  function suggest() {
    setError(null)
    startTransition(async () => {
      try {
        const result = await suggestTimes({ postId: post.id, slots })
        if (!result.ok) { setError(result.error); toast.error(result.error); return }
        setTimes((current) => { const next = { ...current }; for (const [id, time] of Object.entries(result.suggestions)) if (time) next[id] = time; return next })
        const missing = Object.values(result.suggestions).filter((time) => time === null).length
        if (missing) toast.warning(`Nu am gasit o ora libera pentru ${missing} conturi in urmatoarele 60 de zile.`)
        else toast.success('Ore sugerate. Verifica-le inainte de aprobare.')
      } catch { toast.error('Orele nu au putut fi sugerate.') }
    })
  }

  return <div className="space-y-4">
    {error ? <div role="alert" className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-danger">{error}{issues.map((issue) => <div key={issue.accountId} className="mt-2"><p className="font-bold">{issue.account}</p><ul>{issue.errors.map((item, index) => <li key={index}>{item.message}</li>)}{issue.warnings.map((item, index) => <li key={`w-${index}`} className="text-warn">{item.message}</li>)}</ul></div>)}</div> : null}
    <Card><h2 className="font-bold">Destinatii si ore</h2><p className="mt-1 text-sm text-ink-soft">Data si ora sunt in Europe/Bucharest. Schimbarea orelor dupa aprobare cere o aprobare noua.</p>
      {editable ? <div className="mt-4 flex flex-wrap items-end gap-3"><div className="min-w-64 flex-1"><Field label="Ore pentru sugestii" hint="HH:mm, separate prin virgula"><input className={inputClass} value={slots} onChange={(e) => setSlots(e.target.value)} disabled={pending} /></Field></div><Button tone="secondary" disabled={pending} onClick={suggest}>Sugereaza ore</Button></div> : null}
      {!post.destinations.length ? <p className="mt-4 text-sm text-warn">Nicio destinatie. Alege conturile in editor.</p> : <ul className="mt-4 space-y-4">{post.destinations.map((dest) => {
        const canMove = editable && (!dest.job || movable.has(dest.job.status))
        const time = times[dest.account_id]
        return <li key={dest.id} className="border-t border-line pt-4"><div className="flex flex-wrap items-center gap-2"><h3 className="font-bold">{PLATFORM_LABELS[dest.platform]} · {dest.account.display_name}</h3><StatusChip status={dest.job?.status ?? 'draft'} />{dest.account.paused ? <Badge tone="warn">Cont pus pe pauza</Badge> : null}{dest.account.mode === 'auto' && dest.account.status !== 'connected' ? <Badge tone="warn">{dest.account.status}</Badge> : null}</div>
          <p className="mt-2 whitespace-pre-wrap text-sm">{dest.text}</p>
          <div className="mt-3 flex flex-wrap gap-3"><Field label={`Data · ${PLATFORM_LABELS[dest.platform]}`}><input type="date" value={time.date} disabled={pending || !canMove} className={inputClass} onChange={(e) => setTimes({ ...times, [dest.account_id]: { ...time, date: e.target.value } })} /></Field><Field label={`Ora · ${PLATFORM_LABELS[dest.platform]}`}><input type="time" value={time.time} disabled={pending || !canMove} className={inputClass} onChange={(e) => setTimes({ ...times, [dest.account_id]: { ...time, time: e.target.value } })} /></Field></div>
        </li>
      })}</ul>}
      {editable ? <div className="mt-5 space-y-3">
        {!post.approval ? <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={figuresChecked} disabled={pending} onChange={(e) => setFiguresChecked(e.target.checked)} />Am verificat cifrele</label> : null}
        <div className="flex flex-wrap gap-2"><Button tone="secondary" disabled={pending || halfTime} onClick={() => run(() => reschedulePost({ postId: post.id, revisionId: post.revision.id, times }), post.approval ? 'Ore schimbate. Postarea are nevoie de aprobare.' : 'Ore salvate.')}>{post.approval ? 'Reprogrameaza' : 'Salveaza orele'}</Button>{halfTime ? <p className="self-center text-xs text-warn">Completeaza si data, si ora, sau lasa ambele goale.</p> : null}
          {!post.approval ? <Button disabled={pending || halfTime || !post.destinations.length} onClick={() => run(() => approvePost({ postId: post.id, revisionId: post.revision.id, times, figuresChecked }), 'Postarea a fost aprobata si programata.')}>Aproba si programeaza</Button> : null}
          <Button tone="secondary" disabled={pending} onClick={() => run(() => reopenForEdit({ postId: post.id, revisionId: post.revision.id }), 'Editor deschis.', `/admin/social/ciorne/${post.id}`)}>Editeaza</Button>
        </div>
      </div> : null}
    </Card>
    {jobs.length ? <Card><h2 className="mb-3 font-bold">Publicare pe destinatii</h2><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-ink-soft"><tr><th className="p-2">Cont / revizie</th><th className="p-2">Ora</th><th className="p-2">Stare</th><th className="p-2">Rezultat</th><th className="p-2">Actiune</th></tr></thead><tbody>{jobs.map((job: PostJob) => <tr key={job.id} className="border-t border-line"><td className="p-2">{PLATFORM_LABELS[job.platform]} · {job.account_name}<p className="text-xs text-ink-soft">Revizia {job.revision_number} · {job.attempts} incercari</p></td><td className="p-2">{formatBucharest(job.run_at)}</td><td className="p-2"><StatusChip status={job.status} /></td><td className="p-2">{job.remote_url && isHttpUrl(job.remote_url) ? <a href={job.remote_url} target="_blank" rel="noreferrer" className="text-accent-dark hover:underline">Vezi publicarea ↗</a> : '-'}{job.last_error_code ? <p className="mt-1 text-xs text-danger">{job.last_error_code}: {job.last_error_message}</p> : null}{job.status === 'manual_pending' ? <Link className="ml-2 text-accent-dark" href={`/admin/social/manual/${job.id}`}>Publica manual</Link> : null}</td><td className="p-2">{!post.cancelled_at && cancellable.has(job.status) ? <Button tone="danger" disabled={pending} onClick={() => run(() => cancelDestination({ postId: post.id, jobId: job.id }), 'Destinatie anulata.')}>Anuleaza</Button> : null}</td></tr>)}</tbody></table></div>
      {failed.length && post.approval && !post.cancelled_at ? <div className="mt-4 space-y-3">{needsReconcile ? <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={reconcileChecked} disabled={pending} onChange={(e) => setReconcileChecked(e.target.checked)} />Am verificat pe platforma: destinatiile cu RECONCILE_MISS nu au fost publicate.</label> : null}<Button tone="secondary" disabled={pending || (needsReconcile && !reconcileChecked)} onClick={() => run(async () => { const result = await retryFailed({ postId: post.id, confirmReconcileMiss: reconcileChecked }); if (result.ok) { if (result.retried === 0) toast.info('Nimic de reluat.'); for (const skip of result.skipped) toast.warning(skip.message) } return result }, (result) => (result.ok && 'retried' in result && result.retried === 0 ? null : 'Reincercare verificata.'))}>Reincearca doar esuatele</Button></div> : null}
    </Card> : null}
    {!post.cancelled_at ? <div className="flex flex-wrap items-center gap-3"><Button tone="danger" disabled={pending} onClick={() => run(() => cancelPost({ postId: post.id }), 'Postarea a fost anulata unde mai era posibil.')}>Anuleaza postarea</Button><p className="text-xs text-ink-soft">Se anuleaza destinatiile care nu au fost trimise.</p></div> : null}
  </div>
}
