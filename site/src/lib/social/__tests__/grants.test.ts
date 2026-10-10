/**
 * Every public.social_* function is for the service role only (0001 section
 * 12). A migration that adds a function and forgets the grants fails here.
 * The stub creates the three roles with Supabase's default grants, so a
 * forgotten REVOKE leaves anon / authenticated able to execute.
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { PGlite } from '@electric-sql/pglite'
import { migratedDb } from '../../testing/pglite-db.ts'

let db: PGlite
before(async () => {
  db = await migratedDb()
})
after(async () => {
  await db.close()
})

describe('social_* function privileges', () => {
  it('service_role can execute every one; anon and authenticated cannot', async () => {
    const { rows } = await db.query<{ sig: string; svc: boolean; anon: boolean; auth: boolean }>(`
      select p.oid::regprocedure::text as sig,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as svc,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname like 'social\\_%'
       order by 1`)
    assert.ok(rows.length > 30, 'functions found')
    assert.deepEqual(rows.filter((r) => !r.svc).map((r) => r.sig), [], 'missing for service_role')
    assert.deepEqual(rows.filter((r) => r.anon || r.auth).map((r) => r.sig), [], 'open to anon or authenticated')
  })
})
