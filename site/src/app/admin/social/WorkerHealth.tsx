import { Badge, Card } from '@/components/ui'
import { ago } from '@/lib/social/accounts'
import type { WorkerHealth as Health } from '@/lib/social/accounts-queries'

export function WorkerHealth({ health, now }: { health: Health; now: string }) {
  const at = new Date(now)
  return <Card><h2 className="font-bold">Worker si conexiuni</h2><div className="mt-3 flex flex-wrap gap-3 text-sm">
    <Badge tone={health.seen === 'ok' ? 'accent' : 'warn'}>Worker: {ago(health.last_seen_at, at)}</Badge>
    <Badge tone={health.legacy_accounts ? 'warn' : 'accent'}>{health.legacy_accounts ? `Conturi Postiz vechi: ${health.legacy_accounts}` : 'Conectari directe'}</Badge>
    <Badge tone={health.publishing_enabled ? 'accent' : 'warn'}>{health.publishing_enabled ? 'Publicare activa' : 'Publicare oprita'}</Badge>
  </div>{health.seen !== 'ok' && <p className="mt-2 text-sm text-warn">Workerul nu a raspuns in ultimele 5 minute.</p>}
  {health.legacy_accounts ? <p className="mt-2 text-sm text-warn">Postiz a fost scos din aplicatie. Conturile conectate prin Postiz nu mai publica: conecteaza-le direct din Conturi.</p> : null}</Card>
}
