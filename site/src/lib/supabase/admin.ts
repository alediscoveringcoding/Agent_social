import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createLocalAdminClient } from '@/lib/local/admin-client'
import { isLocalMode } from '@/lib/local/mode'

/**
 * Service-role client: bypasses RLS. Server code only, and only after
 * `requireAdmin()` (admin screens) or the worker token check (worker API).
 * This app's own Supabase project, never the website's (amendment 02).
 */
export function createAdminClient(): SupabaseClient {
  // TEMPORARY local mode (src/lib/local/): PGlite files instead of Supabase.
  if (isLocalMode()) return createLocalAdminClient() as unknown as SupabaseClient
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Supabase admin client needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
  }
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}
