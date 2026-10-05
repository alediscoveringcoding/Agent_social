import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getAdminState } from '@/lib/auth/admin'
import { safeNext } from '@/lib/auth/decision'
import { EnrollTotp, VerifyTotp } from './TotpForms'

export const metadata: Metadata = { title: 'Autentificare in doi pasi' }

export default async function MfaPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next)
  const state = await getAdminState()
  if (state.decision === 'login') redirect(`/login?next=${encodeURIComponent(next)}`)
  if (state.decision === 'forbidden') redirect('/login?error=forbidden')
  if (state.decision === 'ok') redirect(next)

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-soft px-4">
      <div className="w-full max-w-sm rounded-card border border-line bg-card p-7 shadow-card">
        <p className="text-xs font-bold uppercase tracking-wide text-accent-dark">Autentificare in doi pasi</p>
        {state.decision === 'enroll' ? (
          <>
            <h1 className="mt-1 text-xl font-extrabold text-ink">Activeaza autentificatorul</h1>
            <p className="mt-1 text-sm text-ink-soft">
              Panoul cere un cod la fiecare intrare. Scaneaza codul QR cu aplicatia de autentificare, apoi scrie codul de 6 cifre.
            </p>
            <EnrollTotp next={next} />
          </>
        ) : (
          <>
            <h1 className="mt-1 text-xl font-extrabold text-ink">Codul din aplicatie</h1>
            <p className="mt-1 text-sm text-ink-soft">Scrie codul de 6 cifre din aplicatia de autentificare.</p>
            <VerifyTotp next={next} />
          </>
        )}
      </div>
    </main>
  )
}
