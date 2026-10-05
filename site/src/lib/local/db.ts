/**
 * TEMPORARY local mode (see mode.ts): the app's database as PGlite (Postgres
 * compiled to WASM) in files under site/.local-db/ (git-ignored), so the app
 * runs with no Docker and no Supabase. The schema is supabase/migrations/,
 * applied on open over the same stub of what Supabase provides that the tests
 * use (src/lib/testing/supabase-stubs.sql); local.migrations records what ran.
 *
 * One process owns the files (.local-db/owner.pid). A second one, such as a
 * script while `npm run dev` runs, is refused instead of corrupting the data.
 *
 * No 'server-only' here: the npm scripts (admin:create, db:*) use it too.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PGlite } from '@electric-sql/pglite'

// next dev / next start and the npm scripts all run from site/.
const SITE_ROOT = process.cwd()
const MIGRATIONS_DIR = join(SITE_ROOT, 'supabase', 'migrations')
const STUBS = join(SITE_ROOT, 'src', 'lib', 'testing', 'supabase-stubs.sql')

/** Tables of local mode itself: the migration log and the local admins (Supabase Auth's job otherwise). */
const LOCAL_SQL = `
create schema if not exists local;
create table if not exists local.migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);
create table if not exists local.admins (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  email          text not null unique,
  password_hash  text not null,
  totp_factor_id uuid,
  totp_secret    text,
  totp_verified  boolean not null default false,
  totp_last_step integer,
  created_at     timestamptz not null default now()
);
`

export class LocalDbInUseError extends Error {
  override name = 'LocalDbInUseError'
}

export function localDbDir(): string {
  return process.env.LOCAL_DB_DIR || join(SITE_ROOT, '.local-db')
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Throws LocalDbInUseError when another live process owns `dir`. */
export function assertNotInUse(dir = localDbDir()): void {
  const file = join(dir, 'owner.pid')
  if (!existsSync(file)) return
  const pid = Number(readFileSync(file, 'utf8').trim())
  if (pid && pid !== process.pid && alive(pid)) {
    throw new LocalDbInUseError(
      `The local database (${dir}) is in use by process ${pid}, probably npm run dev. Stop it, then run this again.`
    )
  }
}

function claim(dir: string): () => void {
  assertNotInUse(dir)
  const file = join(dir, 'owner.pid')
  writeFileSync(file, String(process.pid))
  const release = () => {
    try {
      if (readFileSync(file, 'utf8').trim() === String(process.pid)) rmSync(file)
    } catch {
      // already gone
    }
  }
  process.once('exit', release)
  return release
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/** Applies the Supabase stub (first time), local mode's tables and every new migration. Returns what it applied. */
export async function migrate(db: PGlite): Promise<string[]> {
  const fresh = (await db.query(`select 1 from pg_namespace where nspname = 'auth'`)).rows.length === 0
  if (fresh) await db.exec(readFileSync(STUBS, 'utf8'))
  await db.exec(LOCAL_SQL)
  const done = new Set((await db.query<{ name: string }>('select name from local.migrations')).rows.map((r) => r.name))
  const applied: string[] = []
  for (const f of migrationFiles()) {
    if (done.has(f)) continue
    // One exec = one implicit transaction: the migration and its log row land together or not at all.
    const record = `\n;insert into local.migrations (name) values ('${f.replaceAll("'", "''")}');`
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8') + record)
    } catch (e) {
      throw new Error(`migration ${f} did not apply: ${(e as Error).message}`)
    }
    applied.push(f)
  }
  return applied
}

export interface LocalDb {
  db: PGlite
  /** Migrations applied by this open. */
  applied: string[]
  close(): Promise<void>
}

export async function openLocalDb(dir = localDbDir()): Promise<LocalDb> {
  mkdirSync(dir, { recursive: true })
  const release = claim(dir)
  try {
    const { PGlite } = await import('@electric-sql/pglite')
    const db = await PGlite.create(join(dir, 'pgdata'))
    const applied = await migrate(db)
    return {
      db,
      applied,
      async close() {
        await db.close()
        release()
      },
    }
  } catch (e) {
    release()
    throw e
  }
}

const KEY = Symbol.for('social.local.db')
type Holder = { [KEY]?: Promise<LocalDb> }

/** The server's database: one PGlite per process, kept across hot reloads. */
export function getLocalDb(): Promise<PGlite> {
  const g = globalThis as Holder
  g[KEY] ??= openLocalDb().catch((e) => {
    delete g[KEY]
    throw e
  })
  return g[KEY].then((l) => l.db)
}
