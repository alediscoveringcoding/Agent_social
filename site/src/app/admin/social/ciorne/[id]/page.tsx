import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireAdminPage } from '@/lib/auth/admin'
import { legalNamesFromEnv } from '@/lib/social/content-rules'
import { getDraft } from '@/lib/social/queries'
// W2: available media is loaded only after the page guard.
import { listMedia } from '@/lib/social/media-queries'
import { isHttpUrl } from '@/lib/social/schemas'
import { formatBucharest } from '@/lib/social/time'
import { Badge, PageTitle } from '@/components/ui'
import { DraftEditor } from './DraftEditor'
import { DiscardButton } from '../DiscardButton'
// W3: duplicate the current content into a fresh draft.
import { DuplicateButton } from '../../DuplicateButton'

export const metadata: Metadata = { title: 'Ciorna' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function DraftPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ dest?: string | string[] }> }) {
  const { id } = await params
  const { dest } = await searchParams
  await requireAdminPage(`/admin/social/ciorne/${id}`)
  if (!UUID.test(id)) notFound()
  const draft = await getDraft(id)
  if (!draft) notFound()

  const mediaLibrary = await listMedia(draft.brand.id)
  // Private names: only handed to this admin page so the editor can check copy like the server does.
  const legalNames = legalNamesFromEnv(process.env.SOCIAL_LEGAL_NAMES)
  const initialDest = typeof dest === 'string' ? dest : null
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
          <>
            <DuplicateButton postId={draft.id} />
            {/* W1: approval and scheduling live on the post page. */}
            <Link href={`/admin/social/postari/${draft.id}`} className="rounded-lg border border-line-2 px-3 py-2 text-sm font-semibold text-ink hover:bg-bg-mint">Programare si aprobare</Link>
            {editable ? (
              <DiscardButton postId={draft.id} title={draft.title} redirectTo="/admin/social/ciorne" />
            ) : (
              <Badge tone="warn">{draft.status === 'cancelled' ? 'Renuntata' : 'Nu mai e ciorna'}</Badge>
            )}
          </>
        }
      />
      <DraftEditor key={draft.revision.id} draft={draft} editable={editable} mediaLibrary={mediaLibrary} legalNames={legalNames} initialDest={initialDest} />
    </>
  )
}
