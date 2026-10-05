import type { Metadata } from 'next'
import Link from 'next/link'
import { Card, PageTitle } from '@/components/ui'

export const metadata: Metadata = { title: 'Social' }

/** Overview (A10) comes later; for now the entry points of the drafting flow. */
export default function SocialHome() {
  return (
    <>
      <PageTitle title="Social" subtitle="Genereaza ciorne cu AI, verifica-le si transforma-le in postari." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Link href="/admin/social/genereaza">
          <Card className="h-full transition hover:border-accent">
            <p className="font-bold text-ink">Genereaza ciorne</p>
            <p className="mt-1 text-sm text-ink-soft">Alegi brandul, sursa si platformele. Ciornele apar in cateva minute.</p>
          </Card>
        </Link>
        <Link href="/admin/social/ciorne">
          <Card className="h-full transition hover:border-accent">
            <p className="font-bold text-ink">Ciorne</p>
            <p className="mt-1 text-sm text-ink-soft">Verifica regulile de continut, editeaza textul pe fiecare platforma.</p>
          </Card>
        </Link>
      </div>
    </>
  )
}
