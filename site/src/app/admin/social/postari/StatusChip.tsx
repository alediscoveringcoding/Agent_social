import { Badge } from '@/components/ui'

const labels: Record<string, string> = {
  draft: 'Neaprobata', approved: 'Aprobata', publishing: 'In publicare', published: 'Publicata', partial: 'Partial publicata',
  failed: 'Esuata', cancelled: 'Anulata', queued: 'Programata', claimed: 'Preluata', submitting: 'Se trimite', submitted: 'Trimisa',
  reconciling: 'Se verifica', manual_pending: 'De publicat manual', manual_done: 'Publicata manual',
}
export function StatusChip({ status }: { status: string }) {
  return <Badge tone={status === 'failed' || status === 'partial' ? 'danger' : status === 'published' || status === 'manual_done' ? 'accent' : status === 'reconciling' ? 'warn' : 'neutral'}>{labels[status] ?? status}</Badge>
}
