import type { Metadata } from 'next'
import { requireAdminPage } from '@/lib/auth/admin'
import { listMedia } from '@/lib/social/media-queries'
import { Card, Empty, PageTitle } from '@/components/ui'
import { UploadForm } from './UploadForm'
import { MediaLibrary } from './MediaLibrary'
export const metadata: Metadata = { title: 'Media' }
export default async function MediaPage() {
  await requireAdminPage('/admin/social/media')
  const items = await listMedia()
  return <><PageTitle title="Media" subtitle="Imagini si carduri. Textul alternativ este necesar la fiecare atasare." /><Card><UploadForm /></Card><div className="mt-6">{items.length ? <MediaLibrary items={items} /> : <Empty title="Nicio imagine inca">Incarca prima imagine sau genereaza un card din ciorna.</Empty>}</div></>
}
