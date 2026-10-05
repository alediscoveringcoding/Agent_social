import type { Metadata } from 'next'
import { PageTitle } from '@/components/ui'
import { requireAdminPage } from '@/lib/auth/admin'
import { getWorkerHealth, listAdminAccounts, listBrandsForAccounts } from '@/lib/social/accounts-queries'
import { WorkerHealth } from '../WorkerHealth'
import { AccountsPanel } from './AccountsPanel'

export const metadata: Metadata = { title: 'Conturi' }
export default async function AccountsPage() {
  await requireAdminPage('/admin/social/conturi')
  const [accounts, brands, health] = await Promise.all([listAdminAccounts(), listBrandsForAccounts(), getWorkerHealth()])
  const now = new Date().toISOString()
  return <><PageTitle title="Conturi" subtitle="Atribuie branduri, alege modul de publicare si limitele zilnice." /><div className="space-y-5"><WorkerHealth health={health} now={now} /><AccountsPanel accounts={accounts} brands={brands} now={now} /></div></>
}
