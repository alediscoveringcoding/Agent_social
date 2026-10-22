#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// Backs up site/.local-db (data and private media) and the private environment files
// into ~/agent-social-backups/<timestamp>/. The site must be stopped. Override for tests:
// LOCAL_DB_DIR (source), BACKUP_ROOT (destination), BACKUP_SITE_ENV and BACKUP_WORKER_ENV.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dbDir = process.env.LOCAL_DB_DIR || join(root, 'site', '.local-db')
const backupRoot = process.env.BACKUP_ROOT || join(homedir(), 'agent-social-backups')
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backupDir = join(backupRoot, timestamp)

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' })
    s.once('connect', () => { s.destroy(); resolve(true) })
    s.once('error', () => resolve(false))
    s.setTimeout(1000, () => { s.destroy(); resolve(false) })
  })
}

/** A reason string when the local database must not be copied now, else null. */
async function dbInUse(): Promise<string | null> {
  const lock = join(dbDir, 'owner.pid')
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8').trim())
    if (pid && pid !== process.pid && pidAlive(pid)) return `process ${pid} holds the lock (${lock})`
  }
  // Without an override the site is expected on port 3000.
  if (!process.env.LOCAL_DB_DIR && (await portBusy(3000))) return 'something is listening on port 3000 (the site)'
  return null
}

let saved: string | null = null
console.log(`Backup folder: ${backupDir}\n`)

if (!existsSync(dbDir)) {
  console.log(`Site database: ${dbDir} does not exist, nothing to copy.`)
} else {
  const busy = await dbInUse()
  if (busy) {
    console.error(`Site database NOT backed up: it is in use (${busy}). Stop the site (and worker), then run this again.`)
    process.exitCode = 1
  } else {
    try {
      mkdirSync(backupDir, { recursive: true, mode: 0o700 })
      chmodSync(backupDir, 0o700)
      const dest = join(backupDir, 'local-db')
      cpSync(dbDir, dest, { recursive: true })
      rmSync(join(dest, 'owner.pid'), { force: true })
      saved = dest
      // Encrypted native tokens need the original encryption or session key, so the private
      // environment files go along, outside the public checkout, with mode 0600.
      const siteEnv = process.env.BACKUP_SITE_ENV || (!process.env.LOCAL_DB_DIR ? join(root, 'site', '.env.local') : undefined)
      const workerEnv = process.env.BACKUP_WORKER_ENV || (!process.env.LOCAL_DB_DIR ? join(root, 'worker', '.env') : undefined)
      for (const [name, source] of [['site.env.local', siteEnv], ['worker.env', workerEnv]] as const) {
        if (!source || !existsSync(source)) continue
        const target = join(backupDir, name)
        cpSync(source, target)
        chmodSync(target, 0o600)
      }
      console.log(`Site database saved: ${dbDir} -> ${dest}`)
    } catch (err) {
      console.error(`Site database backup FAILED: ${(err as Error).message}`)
      process.exitCode = 1
    }
  }
}

console.log('')
if (saved) console.log(`Saved:\n  site database  ${saved}`)
if (process.exitCode) console.error('Backup finished WITH PROBLEMS (see above).')
else console.log(`Backup complete: ${backupDir}`)
