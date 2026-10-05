/**
 * TEMPORARY local mode (DB_MODE=local, src/lib/local/): the PGlite database in
 * site/.local-db/.
 *
 *   npm run db:migrate          apply new migrations (the site also does it when it starts)
 *   npm run db:status           applied migrations and admin count
 *   npm run db:reset -- --yes   delete the local database: every draft, account and admin
 *
 * Exit code 3: the database is in use (stop npm run dev first).
 */

import { existsSync, rmSync } from 'node:fs'
import { LocalDbInUseError, assertNotInUse, localDbDir, openLocalDb } from '../src/lib/local/db.ts'

const command = process.argv[2] ?? 'status'

if (process.env.DB_MODE !== 'local') {
  console.log('DB_MODE is not "local" (.env.local): the database is Supabase, nothing to do here.')
  process.exit(0)
}

try {
  const dir = localDbDir()
  if (command === 'reset') {
    if (!process.argv.includes('--yes')) {
      console.error('This deletes every draft, account and admin in the local database. To go ahead: npm run db:reset -- --yes')
      process.exit(1)
    }
    assertNotInUse(dir)
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    console.log(`Deleted ${dir}. It is rebuilt from the migrations on the next db:migrate or site start.`)
    process.exit(0)
  }
  if (command !== 'migrate' && command !== 'status') {
    console.error(`Unknown command "${command}": use migrate, status or reset`)
    process.exit(2)
  }

  const local = await openLocalDb()
  try {
    console.log(local.applied.length ? `Applied: ${local.applied.join(', ')}` : 'Migrations: up to date')
    if (command === 'status') {
      const done = await local.db.query<{ name: string }>('select name from local.migrations order by name')
      console.log(`Database: ${dir}`)
      console.log(`Migrations: ${done.rows.map((r) => r.name).join(', ')}`)
    }
    const admins = (await local.db.query<{ n: number }>('select count(*)::int as n from local.admins')).rows[0].n
    console.log(`Admins: ${admins}${admins === 0 ? ' (create one: npm run admin:create -- --email you@example.com)' : ''}`)
  } finally {
    await local.close()
  }
} catch (e) {
  if (e instanceof LocalDbInUseError) {
    console.error(e.message)
    process.exit(3)
  }
  throw e
}
