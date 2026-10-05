import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { isLocalMode } from '@/lib/local/mode'
import { createLocalSessionClient } from '@/lib/local/session-client'

/**
 * The signed-in admin's session (Supabase Auth, cookies). Used for auth and
 * MFA only; data reads and writes go through the service-role client after
 * `requireAdmin()`.
 */
export async function createSessionClient(): Promise<SessionClient> {
  // TEMPORARY local mode (src/lib/local/): local login instead of Supabase Auth.
  if (isLocalMode()) return (await createLocalSessionClient()) as unknown as SessionClient
  return createSupabaseSessionClient()
}

type SessionClient = Awaited<ReturnType<typeof createSupabaseSessionClient>>

async function createSupabaseSessionClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anon) throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required')
  const cookieStore = await cookies()
  return createServerClient(url, anon, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(toSet) {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options)
        } catch {
          // Called from a Server Component: cookies are read-only there. The
          // proxy refreshes the session on every request, so nothing is lost.
        }
      },
    },
  })
}
