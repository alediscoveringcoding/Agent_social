import type { Metadata } from 'next'
import { LoginForm } from './LoginForm'

export const metadata: Metadata = { title: 'Intra in cont' }

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-soft px-4">
      <div className="w-full max-w-sm rounded-card border border-line bg-card p-7 shadow-card">
        <p className="text-xs font-bold uppercase tracking-wide text-accent-dark">Taxes Support · Social</p>
        <h1 className="mt-1 text-xl font-extrabold text-ink">Intra in cont</h1>
        <p className="mt-1 text-sm text-ink-soft">Doar pentru echipa. Dupa parola iti cerem codul din aplicatia de autentificare.</p>
        {error === 'forbidden' ? (
          <p className="mt-4 rounded-lg bg-danger-soft px-3 py-2 text-sm font-semibold text-danger">
            Contul tau nu are acces la panoul de administrare.
          </p>
        ) : null}
        <LoginForm next={next ?? '/admin/social'} />
      </div>
    </main>
  )
}
