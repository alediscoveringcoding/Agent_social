import type { PGlite } from '@electric-sql/pglite'
import { createFakeSupabase, type FakeSupabase } from '../testing/fake-supabase.ts'
import { getLocalDb } from './db.ts'
// W2: disk-backed private media objects and signed site URLs.
import { withLocalStorage } from './storage.ts'

/**
 * TEMPORARY local mode (see mode.ts): the service-role client answered by the
 * local PGlite, through the same supabase-js subset the tests use
 * (src/lib/testing/fake-supabase.ts). It throws on anything it does not
 * support, so a gap shows up as an error, never as silently wrong data.
 * Storage (media uploads) is private disk storage in this mode.
 */

const KEY = Symbol.for('social.local.adminClient')
type Holder = { [KEY]?: FakeSupabase }

export function createLocalAdminClient(): FakeSupabase {
  const g = globalThis as Holder
  if (!g[KEY]) {
    // The database opens on first use; the client itself is created synchronously.
    const lazy = {
      exec: async (sql: string) => (await getLocalDb()).exec(sql),
      query: async (sql: string, params?: unknown[]) => (await getLocalDb()).query(sql, params),
    } as unknown as PGlite
    g[KEY] = withLocalStorage(createFakeSupabase(lazy))
  }
  return g[KEY]
}
