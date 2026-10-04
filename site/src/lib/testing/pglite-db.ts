/**
 * A real Postgres for the tests, in process: PGlite (Postgres compiled to
 * WASM), built from this app's own migrations over a stub of what Supabase
 * provides (supabase-stubs.sql). No extracted DDL to keep in sync: a new
 * migration is part of the next run, and one that does not apply fails it.
 *
 * Never pointed at anything but an in-memory database.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const SITE_ROOT = join(import.meta.dirname, '..', '..', '..')
export const MIGRATIONS_DIR = join(SITE_ROOT, 'supabase', 'migrations')
const STUBS = join(import.meta.dirname, 'supabase-stubs.sql')

/** Migration files in the order they apply (numeric prefix). */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/** A fresh database with every migration applied. A migration that fails throws, naming the file. */
export async function migratedDb(): Promise<PGlite> {
  const db = await PGlite.create()
  await db.exec(readFileSync(STUBS, 'utf8'))
  for (const f of migrationFiles()) {
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    } catch (e) {
      throw new Error(`migration ${f} did not apply: ${(e as Error).message}`)
    }
  }
  return db
}
