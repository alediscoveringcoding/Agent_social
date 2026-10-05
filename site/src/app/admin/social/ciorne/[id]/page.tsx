import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireAdminPage } from '@/lib/auth/admin'
import { getDraft } from '@/lib/social/queries'
import { isHttpUrl } from '@/lib/social/schemas'
import { formatBucharest } from '@/lib/social/time'
import { Badge, PageTitle } from '@/components/ui'
import { DraftEditor } from './DraftEditor'
import { DiscardButton } from '../DiscardButton'

export const metadata: Metadata = { title: 'Ciorna' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requireAdminPage(`/admin/social/ciorne/${id}`)
  if (!UUID.test(id)) notFound()
  const draft = await getDraft(id)
  if (!draft) notFound()

  const editable = draft.status === 'draft'
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/admin/social/ciorne" className="font-semibold text-accent-dark hover:underline">
          ← Ciorne
        </Link>
      </p>
      <PageTitle
        title={draft.title || '(fara titlu)'}
        subtitle={
          <>
            {draft.brand.name} · revizia {draft.revision.number} din {formatBucharest(draft.revision.created_at)}
            {/* Re-checked here too: rows saved before the schema check could hold javascript: or data: links. */}
            {draft.source_url && isHttpUrl(draft.source_url) ? (
              <>
                {' '}
                · sursa{' '}
                <a href={draft.source_url} target="_blank" rel="noreferrer" className="text-accent-dark hover:underline">
                  {draft.source_url}
                </a>
              </>
            ) : null}
          </>
        }
        actions={
          editable ? (
            <DiscardButton postId={draft.id} title={draft.title} redirectTo="/admin/social/ciorne" />
          ) : (
            <Badge tone="warn">{draft.status === 'cancelled' ? 'Renuntata' : 'Nu mai e ciorna'}</Badge>
          )
        }
      />
      <DraftEditor draft={draft} editable={editable} />
    </>
  )
}
