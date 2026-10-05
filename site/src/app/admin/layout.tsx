import { Toaster } from 'sonner'
import { requireAdminPage } from '@/lib/auth/admin'
import { signOut } from '@/lib/auth/actions'
import { AdminNav } from './AdminNav'

/**
 * Every /admin page: allowlisted user with a TOTP-verified session (aal2),
 * checked on the render path; server actions check again themselves.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdminPage()
  return (
    <div className="min-h-screen bg-bg-soft">
      <header className="border-b border-line bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-3">
          <div className="flex items-center gap-6">
            <span className="text-sm font-extrabold text-ink">
              Taxes Support <span className="text-accent-dark">· Social</span>
            </span>
            <AdminNav />
          </div>
          <form action={signOut} className="flex items-center gap-3 text-xs text-ink-soft">
            <span>{admin.email}</span>
            <button type="submit" className="rounded-md px-2 py-1 font-semibold hover:bg-bg-mint hover:text-ink">
              Iesi
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-8">{children}</main>
      <Toaster position="bottom-right" richColors closeButton />
    </div>
  )
}
