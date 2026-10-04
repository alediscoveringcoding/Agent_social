/**
 * Stands in for `@/lib/supabase/admin` under the test loader (test/hooks.mjs):
 * `createAdminClient()` returns the PGlite-backed fake the test installed.
 */
import type { FakeSupabase } from './fake-supabase.ts'

const KEY = Symbol.for('social.test.adminClient')
type Holder = { [KEY]?: FakeSupabase | null }

export function setTestAdminClient(client: FakeSupabase | null): void {
  ;(globalThis as Holder)[KEY] = client
}

export function createAdminClient(): FakeSupabase {
  const client = (globalThis as Holder)[KEY]
  if (!client) throw new Error('test: no admin client installed (call setTestAdminClient first)')
  return client
}
