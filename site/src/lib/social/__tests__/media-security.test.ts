import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHmac, randomUUID } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import sharp from 'sharp'
import { getLocalDb } from '../../local/db.ts'
import { createLocalAdminClient } from '../../local/admin-client.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { setTestAdmin } from '../../testing/auth-shim.ts'
import { adminUser, resetSocial, rows } from '../../testing/social-fixtures.ts'
import { createUploadTicket, deleteMedia, updateMediaAlt } from '../media-actions.ts'
import { signedMediaUrl } from '../media/signing.ts'
import { POST as upload } from '@/app/api/media/upload/route'

let dir: string
let db: PGlite
let actor: { userId: string; email: string }
let png: Buffer

describe('media signing key', () => {
  it('derives its key from the session secret instead of using it raw, and keeps an explicit secret as is', () => {
    const saved = { m: process.env.MEDIA_SIGNING_SECRET, l: process.env.LOCAL_AUTH_SECRET }
    try {
      const session = 'session-secret-for-tests-0123456789abcdef'
      const id = randomUUID()
      delete process.env.MEDIA_SIGNING_SECRET
      process.env.LOCAL_AUTH_SECRET = session
      const url = signedMediaUrl(id, 600, 1_000_000)
      const sig = new URL(url, 'http://x').searchParams.get('sig')
      const message = `media-download-v1\n${id}\n${1_000_600}`
      assert.notEqual(sig, createHmac('sha256', session).update(message).digest('hex'), 'not the raw session secret')
      const derived = createHmac('sha256', session).update('media-signing-v1').digest()
      assert.equal(sig, createHmac('sha256', derived).update(message).digest('hex'))

      process.env.MEDIA_SIGNING_SECRET = 'explicit-media-secret-0123456789abcdef'
      const explicit = new URL(signedMediaUrl(id, 600, 1_000_000), 'http://x').searchParams.get('sig')
      assert.equal(explicit, createHmac('sha256', process.env.MEDIA_SIGNING_SECRET).update(message).digest('hex'))
    } finally {
      for (const [k, v] of [['MEDIA_SIGNING_SECRET', saved.m], ['LOCAL_AUTH_SECRET', saved.l]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

describe('media actions and upload route hardening', () => {
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'social-media-sec-'))
    process.env.DB_MODE = 'local'; process.env.LOCAL_DB_DIR = dir; process.env.MEDIA_SIGNING_SECRET = 'media-test-key-0123456789abcdef0123456789'
    db = await getLocalDb()
    setTestAdminClient(createLocalAdminClient())
    actor = { userId: await adminUser(db), email: 'admin@example.test' }
    png = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#11a594' } }).png().toBuffer()
  })
  after(async () => {
    setTestAdminClient(null); setTestAdmin(null)
    await db.close(); await rm(dir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    setTestAdminClient(createLocalAdminClient()); setTestAdmin(actor)
    await db.exec('delete from social_upload_tickets')
    await resetSocial(db)
  })

  it('shows the person only intentional messages; any other error is generic', async () => {
    const refusal = await updateMediaAlt({ mediaId: randomUUID(), altText: 'alt' })
    assert.deepEqual(refusal, { ok: false, error: 'Imaginea nu exista.' })

    const real = createLocalAdminClient()
    setTestAdminClient(new Proxy(real, {
      get: (target, prop, receiver) => prop === 'from'
        ? (table: string) => { if (table === 'social_media') throw new Error('relation "social_media" secret detail'); return target.from(table) }
        : Reflect.get(target, prop, receiver),
    }))
    const original = console.error
    const logged: string[] = []
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')) }
    try {
      const result = await deleteMedia(randomUUID())
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.ok(!/secret|relation/.test(result.error), result.error)
        assert.match(result.error, /^Ceva nu a mers/)
      }
    } finally {
      console.error = original
    }
    assert.ok(logged.some((l) => l.includes('secret detail')), 'the real error is logged on the server')
  })

  it('a failing activity log or revalidation does not turn a committed mutation into a failure', async () => {
    const [{ id: brand }] = await rows(db, 'select id from social_brands limit 1')
    const media = randomUUID()
    await db.query(
      `insert into social_media (id, source, storage_path, mime, width, height, bytes, sha256, alt_text, created_by)
       values ($1, 'upload', $2, 'image/png', 1, 1, 1, $3, 'veche', $4)`,
      [media, `uploads/${media}.png`, 'a'.repeat(64), actor.userId]
    )
    void brand
    const real = createLocalAdminClient()
    setTestAdminClient(new Proxy(real, {
      get: (target, prop, receiver) => prop === 'from'
        ? (table: string) => { if (table === 'social_activity_log') throw new Error('log down'); return target.from(table) }
        : Reflect.get(target, prop, receiver),
    }))
    const original = console.error
    console.error = () => {}
    try {
      assert.deepEqual(await updateMediaAlt({ mediaId: media, altText: 'noua' }), { ok: true, mediaId: media })
    } finally {
      console.error = original
    }
    assert.equal((await rows(db, 'select alt_text from social_media where id = $1', [media]))[0].alt_text, 'noua')
  })

  it('claims the upload ticket before decoding: a bad image uses the ticket up, and a new ticket works', async () => {
    const send = (url: string, body: Buffer) =>
      upload(new Request(new URL(url, 'http://localhost:3000'), { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(body) }))
    const first = await createUploadTicket({ mime: 'image/png', bytes: png.length })
    assert.ok(first.ok); if (!first.ok) return
    const corrupt = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('not really a png')])
    assert.equal((await send(first.url, corrupt)).status, 400)
    assert.equal((await rows(db, 'select * from social_upload_tickets')).length, 0, 'the failed ticket is dropped')
    assert.equal((await send(first.url, png)).status, 403, 'the same ticket cannot be used again')

    const second = await createUploadTicket({ mime: 'image/png', bytes: png.length })
    assert.ok(second.ok); if (!second.ok) return
    assert.equal((await send(second.url, png)).status, 200)
    assert.equal((await rows(db, 'select phase from social_upload_tickets'))[0].phase, 'uploaded')
  })
})
