import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ingestVideo } from '../../social/media/video.ts'
import { validateDestination } from '../../social/validation.ts'

function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload); const header = Buffer.alloc(8)
  header.writeUInt32BE(body.length + 8); header.write(type, 4, 4, 'latin1')
  return Buffer.concat([header, body])
}
export function mp4Fixture(): Buffer {
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(1920 * 65536, 76); tkhd.writeUInt32BE(1080 * 65536, 80)
  const mdhd = Buffer.alloc(24); mdhd.writeUInt32BE(1000, 12); mdhd.writeUInt32BE(20000, 16)
  const hdlr = Buffer.alloc(12); hdlr.write('vide', 8)
  const stsd = Buffer.alloc(8); stsd.writeUInt32BE(1, 4)
  const samples = box('stbl', box('stsd', stsd, box('avc1', Buffer.alloc(78))))
  const media = box('mdia', box('mdhd', mdhd), box('hdlr', hdlr), box('minf', samples))
  const track = box('trak', box('tkhd', tkhd), media)
  const movie = box('moov', track, box('udta', Buffer.from('private-location-and-device')))
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom')), movie, box('mdat', Buffer.from([1, 2, 3, 4]))])
}
describe('native MP4 ingest and approval validation', () => {
  it('reads dimensions/duration, strips personal metadata without shifting media offsets and hashes the stored bytes', () => {
    const source = mp4Fixture(); const result = ingestVideo(source)
    assert.equal(result.width, 1920); assert.equal(result.height, 1080); assert.equal(result.durationSeconds, 20)
    assert.equal(result.bytes.length, source.length)
    assert.ok(source.includes('private-location'))
    assert.ok(!result.bytes.includes('private-location'))
    assert.equal(ingestVideo(result.bytes).sha256, result.sha256)
  })
  it('rejects truncated, overflowing and mislabeled files', () => {
    assert.throws(() => ingestVideo(mp4Fixture().subarray(0, 90)), /MP4/)
    const invalid = mp4Fixture(); invalid.writeUInt32BE(0xffffffff, 0)
    assert.throws(() => ingestVideo(invalid), /MP4/)
    assert.throws(() => ingestVideo(mp4Fixture(), 'image/png'), /MP4/)
  })
  it('requires an approved video and explicit audience settings for native YouTube', () => {
    const base = { platform: 'youtube' as const, text: 'Continut', settings: { title: 'Titlu' }, media: [], rules: { native: true } }
    const codes = validateDestination(base).errors.map((issue) => issue.code)
    assert.ok(codes.includes('YOUTUBE_VIDEO_REQUIRED')); assert.ok(codes.includes('YOUTUBE_PRIVACY_REQUIRED')); assert.ok(codes.includes('YOUTUBE_KIDS_REQUIRED'))
    const valid = validateDestination({ ...base, settings: { ...base.settings, privacy_status: 'private', made_for_kids: 'false', synthetic_media: 'false' }, media: [{ mime: 'video/mp4', width: 1920, height: 1080, altText: 'Descriere' }], scheduledAt: new Date(Date.now() + 3600_000).toISOString() })
    assert.equal(valid.ok, true, JSON.stringify(valid.errors))
  })
})
