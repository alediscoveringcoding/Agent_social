import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/admin'
import { isUuid } from '@/lib/social/server/run-admin-action'
import { PageTitle } from '@/components/ui'
import type { CandidateSummary } from '@/lib/native/candidates'
import { SelectDestination } from './SelectDestination'

export default async function ConnectionDestinationPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireAdmin()
  const { id } = await params
  if (!isUuid(id)) notFound()
  const { data, error } = await createAdminClient().from('social_native_candidates').select('destinations')
    .eq('id', id).eq('actor_id', actor.userId).is('consumed_at', null).gt('expires_at', new Date().toISOString()).maybeSingle()
  if (error || !data) notFound()
  return <><PageTitle title="Alege contul" subtitle="Selecteaza profilul, pagina sau canalul pentru acest brand. Contul va porni pe pauza." />
    <SelectDestination id={id} destinations={data.destinations as CandidateSummary[]} /></>
}
