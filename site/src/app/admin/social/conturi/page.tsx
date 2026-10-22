import type { Metadata } from 'next'
import { PageTitle } from '@/components/ui'
import { requireAdminPage } from '@/lib/auth/admin'
import { getWorkerHealth, listAdminAccounts, listBrandsForAccounts } from '@/lib/social/accounts-queries'
import { WorkerHealth } from '../WorkerHealth'
import { AccountsPanel } from './AccountsPanel'
import { NativeConnectionForm } from './NativeConnectionForm'
import { OAuthConnectionForm } from './OAuthConnectionForm'

export const metadata: Metadata = { title: 'Conturi' }
export default async function AccountsPage({ searchParams }: { searchParams: Promise<{ connection_error?: string }> }) {
  await requireAdminPage('/admin/social/conturi')
  const [accounts, brands, health] = await Promise.all([listAdminAccounts(), listBrandsForAccounts(), getWorkerHealth()])
  const now = new Date().toISOString()
  const query = await searchParams
  return <><PageTitle title="Conturi" subtitle="Conecteaza conturile existente, alege brandurile si limitele zilnice." /><div className="space-y-5">
    {query.connection_error ? <p role="alert" className="rounded border border-line bg-card p-4 text-sm text-danger">Autorizarea nu a reusit sau a expirat. Verifica datele aplicatiei de developer, adresa de callback si permisiunile, apoi reia conectarea.</p> : null}
    <WorkerHealth health={health} now={now} /><OAuthConnectionForm brands={brands} /><NativeConnectionForm brands={brands} /><AccountsPanel accounts={accounts} brands={brands} now={now} /></div></>
}
