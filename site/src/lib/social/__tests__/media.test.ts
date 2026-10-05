import { after, before, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import type { PGlite } from '@electric-sql/pglite'
import sharp from 'sharp'
import { getLocalDb } from '../../local/db.ts'
import { createLocalAdminClient } from '../../local/admin-client.ts'
import { LocalBucket, storagePath } from '../../local/storage.ts'
import { createFakeSupabase } from '../../testing/fake-supabase.ts'
import { setTestAdminClient } from '../../testing/admin-shim.ts'
import { setTestAdmin } from '../../testing/auth-shim.ts'
import { adminUser, brandId, createAccount, resetSocial, rows, scheduleAndApprove } from '../../testing/social-fixtures.ts'
import { routeFetch } from '../../testing/route-fetch.ts'
import { SOCIAL_BUCKET } from '../constants.ts'
import { createUploadTicket, finalizeUpload, generateCards, setDestinationMedia, updateMediaAlt, deleteMedia } from '../media-actions.ts'
import { listMedia } from '../media-queries.ts'
import { ingestImage, MAX_UPLOAD_BYTES } from '../media/ingest.ts'
import { signedMediaUrl, verifyMediaSignature, verifyUploadTicket, signUploadTicket } from '../media/signing.ts'
import { destinationHash } from '../hash.ts'
import { WorkerApi } from '../fake/worker-api-client.ts'
import { runFakeWorkerOnce } from '../fake/fake-worker.ts'
import { POST as upload } from '@/app/api/media/upload/route'
import { GET as download } from '@/app/api/media/[id]/route'
import { GET as cardPreview } from '@/app/admin/social/media/card-preview/route'

let dir: string
let db: PGlite
let brand: string
let actor: { userId: string; email: string }
const KEY = 'media-test-key-0123456789abcdef0123456789'
const TOKEN = 'media-worker-token-0123456789abcdef'
let png: Buffer
const api = new WorkerApi({ baseUrl: 'http://localhost:3000', token: TOKEN, workerId: 'media-worker', fetch: routeFetch })

async function stage(bytes = png, mime = 'image/png') {
  const ticket = await createUploadTicket({ mime, bytes: bytes.length })
  assert.equal(ticket.ok, true, JSON.stringify(ticket))
  if (!ticket.ok) throw new Error('ticket missing')
  const res = await upload(new Request(new URL(ticket.url, 'http://localhost:3000'), { method: 'POST', headers: { 'Content-Type': mime }, body: new Uint8Array(bytes) }))
  assert.equal(res.status, 200, await res.text())
  return ticket
}
async function uploaded(bytes = png, mime = 'image/png') {
  const ticket = await stage(bytes, mime)
  const final = await finalizeUpload({ ticket: ticket.ticket, altText: 'Imagine de test' })
  assert.equal(final.ok, true, JSON.stringify(final))
  if (!final.ok) throw new Error('final missing')
  return { id: final.mediaId, ticket }
}
async function draft(scheduledAt: string | null = null) {
  const accountId = await createAccount(db, brand)
  const [{ id: postId }] = await rows(db, `select social_create_post($1::jsonb, $2::jsonb, $3::jsonb) as id`, [JSON.stringify({ brand_id: brand, kind: 'social', title: 'Ciorna media', created_by: actor.userId }), JSON.stringify({ canonical_text: 'Salut de la test', card_spec: null }), JSON.stringify([{ account_id: accountId, text: 'Salut de la test', settings: {}, scheduled_at: scheduledAt }])])
  const [{ current_revision_id: revisionId }] = await rows(db, 'select current_revision_id from social_posts where id = $1', [postId])
  return { postId: postId as string, revisionId: revisionId as string, accountId }
}
async function hashOf(revisionId: string) {
  const [dest] = await rows(db, `select d.*, coalesce((select jsonb_agg(jsonb_build_object('sha256', sm.sha256, 'alt_text', m.alt_text) order by m.position) from social_destination_media m join social_media sm on sm.id=m.media_id where m.destination_id=d.id), '[]'::jsonb) media from social_destinations d where d.revision_id=$1`, [revisionId])
  return destinationHash({ account_id: dest.account_id, platform: dest.platform, text: dest.text, settings: dest.settings, scheduled_at: dest.scheduled_at ?? '2030-01-01T12:00:00Z', media: dest.media })
}
const mediaFetch = (async (input: string | URL | Request) => {
  const request = input instanceof Request ? input : new Request(input)
  const id = new URL(request.url).pathname.split('/').at(-1)!
  return download(request, { params: Promise.resolve({ id }) })
}) as typeof fetch

describe('media in local mode', () => {
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'social-media-'))
    process.env.DB_MODE = 'local'; process.env.LOCAL_DB_DIR = dir; process.env.MEDIA_SIGNING_SECRET = KEY
    process.env.WORKER_TOKEN = TOKEN; process.env.SOCIAL_PUBLISHING_ENABLED = 'true'
    db = await getLocalDb()
    setTestAdminClient(createLocalAdminClient())
    brand = await brandId(db)
    actor = { userId: await adminUser(db), email: 'admin@example.test' }
    png = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#11a594' } }).png().toBuffer()
  })
  after(async () => {
    setTestAdminClient(null); setTestAdmin(null)
    await db.close(); await rm(dir, { recursive: true, force: true })
  })
  beforeEach(async () => {
    process.env.DB_MODE = 'local'; process.env.MEDIA_SIGNING_SECRET = KEY
    setTestAdminClient(createLocalAdminClient()); setTestAdmin(actor)
    await db.exec('delete from social_upload_tickets')
    await resetSocial(db)
    await rm(join(dir, 'storage'), { recursive: true, force: true })
  })
  it('refuses all six actions without an admin before reading or writing', async () => {
    setTestAdmin(null)
    const id = randomUUID()
    const attempts = [await createUploadTicket({ mime: 'image/png', bytes: 10 }), await finalizeUpload({ ticket: 'bad', altText: 'test' }), await generateCards({ postId: id, baseRevisionId: id, spec: {} }), await setDestinationMedia({ postId: id, baseRevisionId: id, accountId: id, media: [] }), await updateMediaAlt({ mediaId: id, altText: 'alt' }), await deleteMedia(id)]
    for (const attempt of attempts) assert.equal(attempt.ok, false)
    assert.equal((await rows(db, 'select * from social_media')).length, 0)
    assert.equal((await rows(db, 'select * from social_upload_tickets')).length, 0)
    assert.equal((await rows(db, 'select * from social_activity_log')).length, 0)
    assert.equal((await cardPreview(new Request('http://localhost:3000/admin/social/media/card-preview'))).status, 403)
  })
  it('uploads JPEG, applies orientation, strips EXIF/GPS and stores exact hashes', async () => {
    const jpeg = await sharp({ create: { width: 48, height: 24, channels: 3, background: '#16313a' } }).withExif({ IFD0: { Artist: 'fixture' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '44/1 0/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '26/1 0/1 0/1' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer()
    assert.ok((await sharp(jpeg).metadata()).exif)
    const { id } = await uploaded(jpeg, 'image/jpeg')
    const [m] = await rows(db, 'select * from social_media where id=$1', [id])
    const bytes = await readFile(storagePath(SOCIAL_BUCKET, m.storage_path))
    const metadata = await sharp(bytes).metadata()
    assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined); assert.equal(metadata.xmp, undefined)
    assert.equal(metadata.width, 24); assert.equal(metadata.height, 48)
    assert.equal(m.width, metadata.width); assert.equal(m.height, metadata.height)
    assert.equal(m.bytes, bytes.length); assert.equal(m.sha256, createHash('sha256').update(bytes).digest('hex'))
    const logs = JSON.stringify(await rows(db, 'select details from social_activity_log'))
    assert.ok(!logs.includes('ticket') && !logs.includes('sig='))
  })
  it('rejects wrong magic, wrong MIME, oversize, empty and animated inputs', async () => {
    await assert.rejects(ingestImage(Buffer.from('not an image'), 'image/png'))
    await assert.rejects(ingestImage(png, 'image/jpeg'))
    await assert.rejects(ingestImage(Buffer.alloc(MAX_UPLOAD_BYTES + 1)))
    await assert.rejects(ingestImage(Buffer.alloc(0)))
    const animation = await sharp(Buffer.concat([Buffer.alloc(4 * 4 * 3, 100), Buffer.alloc(4 * 4 * 3, 200)]), { raw: { width: 4, height: 8, channels: 3, pageHeight: 4 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer()
    assert.equal((await sharp(animation).metadata()).pages, 2)
    await assert.rejects(ingestImage(animation, 'image/webp'), /statica/)
    const ticket = await createUploadTicket({ mime: 'image/png', bytes: 10 })
    assert.ok(ticket.ok)
    if (!ticket.ok) return
    assert.equal((await upload(new Request(new URL(ticket.url, 'http://localhost:3000'), { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array(png) }))).status, 415)
    assert.equal((await upload(new Request(new URL(ticket.url, 'http://localhost:3000'), { method: 'POST', headers: { 'Content-Type': 'image/png', 'Content-Length': String(MAX_UPLOAD_BYTES + 1) }, body: new Uint8Array(png) }))).status, 400)
    assert.equal((await createUploadTicket({ mime: 'image/gif', bytes: 5 })).ok, false)
  })
  it('requires alt text and the upload owner, with single-use upload and finalize phases', async () => {
    const ticket = await stage()
    assert.equal((await finalizeUpload({ ticket: ticket.ticket, altText: ' ' })).ok, false)
    const second = { userId: await adminUser(db, 'other@example.test'), email: 'other@example.test' }
    setTestAdmin(second)
    assert.equal((await finalizeUpload({ ticket: ticket.ticket, altText: 'alt' })).ok, false)
    setTestAdmin(actor)
    const results = await Promise.all([finalizeUpload({ ticket: ticket.ticket, altText: 'alt' }), finalizeUpload({ ticket: ticket.ticket, altText: 'alt' })])
    assert.equal(results.filter((r) => r.ok).length, 1)
    assert.equal((await upload(new Request(new URL(ticket.url, 'http://localhost:3000'), { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(png) }))).status, 403)
    assert.equal((await finalizeUpload({ ticket: ticket.ticket, altText: 'alt' })).ok, false)
    assert.equal((await rows(db, 'select * from social_media')).length, 1)
  })
  it('serves signed URLs and rejects expired, tampered, far-future and malformed signatures', async () => {
    const { id } = await uploaded()
    const url = signedMediaUrl(id)
    const response = await mediaFetch(new URL(url, 'http://localhost:3000'))
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    const cases = [url.replace('sig=', 'sig=0'), signedMediaUrl(id, 1, Math.floor(Date.now() / 1000) - 2), signedMediaUrl(id, 3600, Math.floor(Date.now() / 1000) + 120), url.replace(/exp=\d+/, 'exp=NaN'), `/api/media/${randomUUID()}${url.slice(url.indexOf('?'))}`]
    for (const candidate of cases) assert.equal((await mediaFetch(new URL(candidate, 'http://localhost:3000'))).status, 403, candidate)
    assert.equal(verifyMediaSignature(id, Math.floor(Date.now() / 1000) + 10, 'z'.repeat(64)), false)
    const old = verifyUploadTicket((await createUploadTicket({ mime: 'image/png', bytes: png.length }) as { ticket: string }).ticket)!
    assert.equal(verifyUploadTicket(signUploadTicket({ ...old, exp: Math.floor(Date.now() / 1000) - 1 })), null)
    assert.equal(verifyUploadTicket(signUploadTicket({ ...old, path: 'staging/../../outside' })), null)
  })
  it('creates a new revision for attaching media and alt-only changes; library alt stays a suggestion', async () => {
    const { id } = await uploaded()
    const d = await draft(); const before = await hashOf(d.revisionId)
    const attached = await setDestinationMedia({ postId: d.postId, baseRevisionId: d.revisionId, accountId: d.accountId, media: [{ mediaId: id }] })
    assert.ok(attached.ok, JSON.stringify(attached)); if (!attached.ok) return
    const mediaHash = await hashOf(attached.revisionId); assert.notEqual(mediaHash, before)
    assert.equal((await updateMediaAlt({ mediaId: id, altText: 'Sugestie schimbata' })).ok, true)
    assert.equal(await hashOf(attached.revisionId), mediaHash)
    const alt = await setDestinationMedia({ postId: d.postId, baseRevisionId: attached.revisionId, accountId: d.accountId, media: [{ mediaId: id, altText: 'Alt atasat schimbat' }] })
    assert.ok(alt.ok); if (!alt.ok) return
    assert.notEqual(await hashOf(alt.revisionId), mediaHash)
    assert.equal((await setDestinationMedia({ postId: d.postId, baseRevisionId: attached.revisionId, accountId: d.accountId, media: [] })).ok, false)
    assert.equal((await deleteMedia(id)).ok, false)
    assert.ok((await listMedia())[0]?.attached)
  })
  it('preserves schedule on media edit and requires reopening approved revisions', async () => {
    const { id } = await uploaded()
    const time = '2030-01-01T12:00:00Z'
    const d = await draft(time)
    const attached = await setDestinationMedia({ postId: d.postId, baseRevisionId: d.revisionId, accountId: d.accountId, media: [{ mediaId: id }] })
    assert.ok(attached.ok); if (!attached.ok) return
    const [saved] = await rows(db, 'select scheduled_at from social_destinations where revision_id=$1', [attached.revisionId])
    assert.equal(new Date(saved.scheduled_at).toISOString(), '2030-01-01T12:00:00.000Z')
    const approved = await scheduleAndApprove(db, d.postId, actor.userId)
    assert.equal((await setDestinationMedia({ postId: d.postId, baseRevisionId: approved.revision, accountId: d.accountId, media: [] })).ok, false)
    assert.equal((await updateMediaAlt({ mediaId: id, altText: 'Sugestie noua dupa aprobare' })).ok, true)
    const [copy] = await rows(db, 'select alt_text from social_destination_media m join social_destinations d on d.id=m.destination_id where d.revision_id=$1', [approved.revision])
    assert.equal(copy.alt_text, 'Imagine de test')
    await assert.rejects(rows(db, 'update social_destination_media m set alt_text=$1 from social_destinations d where d.id=m.destination_id and d.revision_id=$2', ['bypass', approved.revision]), /FROZEN|APPROVED/i)
  })
  it('generates a stored card using the authoritative brand and destination format', async () => {
    const d = await draft()
    const result = await generateCards({ postId: d.postId, baseRevisionId: d.revisionId, spec: { template: 'dark', headline: 'Titlu de test', keyword: 'test', stat: '16%', subline: 'Descriere', brand: 'other', alt_text: 'Card de test' } })
    assert.ok(result.ok, JSON.stringify(result)); if (!result.ok) return
    const [card] = await rows(db, 'select * from social_media where id=$1', [result.mediaIds[0]])
    assert.equal(card.source, 'generated'); assert.equal(card.format, 'x'); assert.equal(card.card_spec.brand, 'taxes-support')
    assert.equal(card.brand_id, brand); assert.equal(card.width, 1600); assert.equal(card.height, 900)
    const [revision] = await rows(db, 'select figures from social_post_revisions where id=$1', [result.revisionId])
    assert.ok(revision.figures.some((f: { value: string; source: string }) => f.value === '16%' && f.source === 'unverified'))
    assert.notEqual(await hashOf(result.revisionId), await hashOf(d.revisionId))
    const preview = new URL('http://localhost:3000/admin/social/media/card-preview')
    preview.search = new URLSearchParams({ postId: d.postId, revisionId: result.revisionId, format: 'x', template: 'light', headline: 'Previzualizare' }).toString()
    assert.equal((await cardPreview(new Request(preview))).status, 200)
    assert.equal((await generateCards({ postId: d.postId, baseRevisionId: result.revisionId, spec: { template: 'dark', headline: 'Titlu', keyword: 'absent', alt_text: 'test' } })).ok, false)
    assert.equal((await generateCards({ postId: d.postId, baseRevisionId: result.revisionId, spec: { template: 'dark', headline: 'Profit sigur', alt_text: 'test' } })).ok, false)
    const next = await draft()
    const reused = await setDestinationMedia({ postId: next.postId, baseRevisionId: next.revisionId, accountId: next.accountId, media: [{ mediaId: card.id }] })
    assert.ok(reused.ok); if (!reused.ok) return
    const [copyRevision] = await rows(db, 'select figures from social_post_revisions where id=$1', [reused.revisionId])
    assert.ok(copyRevision.figures.some((f: { value: string; source: string }) => f.value === '16%' && f.source === 'unverified'))
  })
  it('downloads local claim payload URLs and verifies checksums before the fake worker publishes', async () => {
    const { id } = await uploaded(); const d = await draft()
    assert.equal((await setDestinationMedia({ postId: d.postId, baseRevisionId: d.revisionId, accountId: d.accountId, media: [{ mediaId: id }] })).ok, true)
    const approved = await scheduleAndApprove(db, d.postId, actor.userId)
    const steps = await runFakeWorkerOnce(api, { scenario: 'ok', downloadMedia: true, mediaFetch })
    assert.ok(steps.some((s) => s.action === 'media verified' && s.status === 200))
    assert.ok(steps.some((s) => s.action === 'submitted' && s.status === 200))
    await rows(db, 'update social_delivery_jobs set next_check_at=now() where id=$1', [approved.jobs[0]])
    await runFakeWorkerOnce(api, { scenario: 'ok', downloadMedia: true, mediaFetch })
    const [job] = await rows(db, 'select status,remote_url from social_delivery_jobs where id=$1', [approved.jobs[0]])
    assert.equal(job.status, 'published'); assert.match(job.remote_url, /^https:\/\/example.com\/fake\//)
  })
  it('fails checksum mismatch before submitting', async () => {
    const { id } = await uploaded(); const d = await draft()
    await setDestinationMedia({ postId: d.postId, baseRevisionId: d.revisionId, accountId: d.accountId, media: [{ mediaId: id }] })
    const approved = await scheduleAndApprove(db, d.postId, actor.userId)
    await createLocalAdminClient().storage.from(SOCIAL_BUCKET).upload(`uploads/${id}.png`, Buffer.from('corrupt'), { upsert: true })
    const steps = await runFakeWorkerOnce(api, { scenario: 'ok', downloadMedia: true, mediaFetch })
    assert.ok(steps.some((s) => s.action === 'failed MEDIA_FETCH_FAILED'))
    const [job] = await rows(db, 'select status,last_error_code from social_delivery_jobs where id=$1', [approved.jobs[0]])
    assert.equal(job.status, 'failed'); assert.equal(job.last_error_code, 'MEDIA_FETCH_FAILED')
    assert.equal((await rows(db, 'select submitting_at from social_publish_attempts where job_id=$1', [approved.jobs[0]]))[0].submitting_at, null)
  })
  it('deletes only unattached media and removes the disk object', async () => {
    const { id } = await uploaded()
    const [m] = await rows(db, 'select storage_path from social_media where id=$1', [id])
    assert.equal((await deleteMedia(id)).ok, true)
    assert.equal((await rows(db, 'select * from social_media where id=$1', [id])).length, 0)
    await assert.rejects(readFile(storagePath(SOCIAL_BUCKET, m.storage_path)))
  })
  it('normalizes the Supabase staged upload path without real service calls', async () => {
    delete process.env.DB_MODE
    const fake = createFakeSupabase(db); setTestAdminClient(fake)
    const ticket = await createUploadTicket({ mime: 'image/png', bytes: png.length })
    assert.ok(ticket.ok); if (!ticket.ok) return
    assert.equal(ticket.method, 'PUT'); assert.match(ticket.url, /^http:\/\/storage.test\/upload\//)
    const t = verifyUploadTicket(ticket.ticket)!
    await fake.storage.from(SOCIAL_BUCKET).upload(t.path, png)
    const result = await finalizeUpload({ ticket: ticket.ticket, altText: 'Imagine din Storage' })
    assert.ok(result.ok, JSON.stringify(result))
    assert.equal((await finalizeUpload({ ticket: ticket.ticket, altText: 'replay' })).ok, false)
    assert.equal((await upload(new Request('http://localhost:3000/api/media/upload'))).status, 404)
    assert.equal(fake.objects.has(`${SOCIAL_BUCKET}/${t.path}`), false)
  })
  it('restricts upload-ticket table and phase function to the service role', async () => {
    const [privileges] = await rows(db, `select has_table_privilege('anon', 'social_upload_tickets', 'SELECT') as anon_table, has_function_privilege('authenticated', 'social_take_upload_ticket(text,uuid,text,text,text)', 'EXECUTE') as auth_fn, has_function_privilege('service_role', 'social_take_upload_ticket(text,uuid,text,text,text)', 'EXECUTE') as service_fn`)
    assert.deepEqual(privileges, { anon_table: false, auth_fn: false, service_fn: true })
  })
  it('refuses traversal, backslashes, symlink parents and symlink objects', async () => {
    const bucket = new LocalBucket(SOCIAL_BUCKET, createLocalAdminClient())
    for (const path of ['../outside', '/outside', 'ok/../../outside', 'ok\\outside', 'ok//outside', './outside']) assert.ok((await bucket.upload(path, png)).error, path)
    assert.ok((await bucket.upload('safe/image.png', png)).data)
    const first = await bucket.download('safe/image.png'); assert.ok(first.data)
    assert.ok((await bucket.upload('safe/image.png', Buffer.from('overwrite'))).error)
    assert.deepEqual(Buffer.from(await (await bucket.download('safe/image.png')).data!.arrayBuffer()), png)
    const external = join(dir, 'external'); await mkdir(external)
    await symlink(external, storagePath(SOCIAL_BUCKET, 'unsafe'))
    assert.ok((await bucket.upload('unsafe/image.png', png)).error)
    await symlink(storagePath(SOCIAL_BUCKET, 'safe/image.png'), storagePath(SOCIAL_BUCKET, 'safe/link.png'))
    assert.ok((await bucket.download('safe/link.png')).error); assert.ok((await bucket.remove(['safe/link.png'])).error)
    assert.ok((await bucket.upload('safe/link.png', png, { upsert: true })).error)
  })
})
