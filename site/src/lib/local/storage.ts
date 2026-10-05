import { constants } from 'node:fs'
import { lstat, mkdir, open, link, rename, unlink } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { FakeSupabase } from '../testing/fake-supabase.ts'
import { localDbDir } from './db.ts'
import { signedMediaUrl } from '../social/media/signing.ts'

function segment(value: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid storage bucket')
}
export function storagePath(bucket: string, path: string): string {
  segment(bucket)
  if (!path || path.includes('\\') || path.includes('\0') || path.split('/').some((p) => !p || p === '.' || p === '..') || path.startsWith('/')) throw new Error('Invalid storage path')
  return join(resolve(localDbDir()), 'storage', bucket, path)
}
/** Check every ancestor, including a configured DB directory that is a symlink. */
async function safeDirectory(dir: string, create: boolean) {
  const absolute = resolve(dir)
  let current = parse(absolute).root
  for (const part of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part)
    if (create) await mkdir(current, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e })
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe storage directory')
  }
}
const failure = (e: unknown) => ({ message: e instanceof Error ? e.message : 'Storage failed', statusCode: '400' })

export class LocalBucket {
  private bucket: string
  private db: Pick<FakeSupabase, 'from'>
  constructor(bucket: string, db: Pick<FakeSupabase, 'from'>) {
    segment(bucket); this.bucket = bucket; this.db = db
  }
  async upload(path: string, body: Uint8Array | ArrayBuffer | Blob, opts: { contentType?: string; upsert?: boolean } = {}) {
    let temp: string | undefined
    try {
      const file = storagePath(this.bucket, path)
      await safeDirectory(dirname(file), true)
      temp = join(dirname(file), `.upload-${randomUUID()}`)
      const handle = await open(/* turbopackIgnore: true */ temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try {
        const bytes = body instanceof Blob ? Buffer.from(await body.arrayBuffer()) : body instanceof ArrayBuffer ? Buffer.from(body) : body
        await handle.writeFile(bytes); await handle.sync()
      } finally { await handle.close() }
      // Hard-link publication is atomic and never overwrites a previous object.
      if (opts.upsert) {
        const existing = await lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return null })
        if (existing && !existing.isFile()) throw new Error('Unsafe storage file')
        await rename(temp, file); temp = undefined
      } else await link(temp, file)
      return { data: { path }, error: null }
    } catch (e) { return { data: null, error: failure(e) } }
    finally { if (temp) await unlink(temp).catch(() => {}) }
  }
  async download(path: string) {
    try {
      const file = storagePath(this.bucket, path)
      await safeDirectory(dirname(file), false)
      const handle = await open(/* turbopackIgnore: true */ file, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        if (!(await handle.stat()).isFile()) throw new Error('Unsafe storage file')
        const bytes = await handle.readFile()
        const type = path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : path.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream'
        return { data: new Blob([new Uint8Array(bytes)], { type }), error: null }
      } finally { await handle.close() }
    } catch (e) { return { data: null, error: failure(e) } }
  }
  async remove(paths: string[]) {
    try {
      for (const path of paths) {
        const file = storagePath(this.bucket, path)
        try { await safeDirectory(dirname(file), false) }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e }
        const stat = await lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; return null })
        if (stat && !stat.isFile()) throw new Error('Unsafe storage file')
        if (stat) await unlink(file)
      }
      return { data: paths.map((name) => ({ name })), error: null }
    } catch (e) { return { data: null, error: failure(e) } }
  }
  async createSignedUrls(paths: string[], ttl: number) {
    try {
      for (const path of paths) storagePath(this.bucket, path)
      const { data, error } = await this.db.from('social_media').select('id, storage_path').in('storage_path', paths)
      if (error) throw new Error(error.message)
      const ids = new Map(((data ?? []) as Array<{ id: string; storage_path: string }>).map((m) => [m.storage_path, m.id]))
      return { data: paths.map((path) => ({ path, signedUrl: ids.has(path) ? signedMediaUrl(ids.get(path)!, ttl) : '', error: ids.has(path) ? null : 'Media not found' })), error: null }
    } catch (e) { return { data: null, error: failure(e) } }
  }
  async createSignedUrl(path: string, ttl: number) {
    const res = await this.createSignedUrls([path], ttl)
    const row = res.data?.[0]
    return { data: row?.signedUrl ? { signedUrl: row.signedUrl } : null, error: res.error ?? (row?.error ? { message: row.error } : null) }
  }
}

export function withLocalStorage(fake: FakeSupabase): FakeSupabase {
  return { ...fake, storage: { from: (bucket: string) => new LocalBucket(bucket, fake) } } as unknown as FakeSupabase
}
