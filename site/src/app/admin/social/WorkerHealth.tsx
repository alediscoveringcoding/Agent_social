import { Badge, Card } from '@/components/ui'
import { ago } from '@/lib/social/accounts'
import type { WorkerHealth as Health } from '@/lib/social/accounts-queries'

export function WorkerHealth({ health, now }: { health: Health; now: string }) {
  const at = new Date(now)
  return <Card><h2 className="font-bold">Worker si sincronizare</h2><div className="mt-3 flex flex-wrap gap-3 text-sm">
    <Badge tone={health.seen === 'ok' ? 'accent' : 'warn'}>Worker: {ago(health.last_seen_at, at)}</Badge>
    <Badge tone={health.sync === 'ok' ? 'accent' : 'warn'}>Conturi: {ago(health.last_account_sync_at, at)}</Badge>
    <Badge tone={health.publishing_enabled ? 'accent' : 'warn'}>{health.publishing_enabled ? 'Publicare activa' : 'Publicare oprita'}</Badge>
  </div>{health.seen !== 'ok' && <p className="mt-2 text-sm text-warn">Workerul nu a raspuns in ultimele 5 minute.</p>}
  {health.sync !== 'ok' && <p className="mt-2 text-sm text-warn">Conturile nu au fost sincronizate in ultimele 30 de minute.</p>}</Card>
}
