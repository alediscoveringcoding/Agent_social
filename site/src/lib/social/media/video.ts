import { createHash } from 'node:crypto'

export const MAX_VIDEO_BYTES = 128 * 1024 * 1024
const INVALID = 'Foloseste un video MP4 valid, H.264, cu cel mult 128 MB.'
interface Box { type: string; start: number; payload: number; end: number }

/** A bounded ISO BMFF parser. No native process, codec execution or container. */
function boxes(bytes: Buffer, from: number, end: number): Box[] {
  const result: Box[] = []
  let offset = from
  while (offset < end) {
    if (end - offset < 8 || result.length > 100_000) throw new Error(INVALID)
    let size = bytes.readUInt32BE(offset)
    let header = 8
    if (size === 1) {
      if (end - offset < 16) throw new Error(INVALID)
      const large = bytes.readBigUInt64BE(offset + 8)
      if (large > BigInt(MAX_VIDEO_BYTES)) throw new Error(INVALID)
      size = Number(large); header = 16
    } else if (size === 0) size = end - offset
    if (size < header || size > end - offset) throw new Error(INVALID)
    result.push({ type: bytes.toString('latin1', offset + 4, offset + 8), start: offset, payload: offset + header, end: offset + size })
    offset += size
  }
  return result
}
function child(bytes: Buffer, parent: Box, type: string): Box {
  const box = boxes(bytes, parent.payload, parent.end).find((item) => item.type === type)
  if (!box) throw new Error(INVALID)
  return box
}
function need(box: Box, minimum: number) { if (box.end - box.payload < minimum) throw new Error(INVALID) }
function stripMetadata(bytes: Buffer, list: Box[], depth = 0): void {
  if (depth > 8) throw new Error(INVALID)
  for (const box of list) {
    if (['udta', 'meta', 'uuid', 'free', 'skip'].includes(box.type)) {
      bytes.write('free', box.start + 4, 4, 'ascii')
      bytes.fill(0, box.payload, box.end)
    } else if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf'].includes(box.type)) stripMetadata(bytes, boxes(bytes, box.payload, box.end), depth + 1)
  }
}
export function ingestVideo(input: Uint8Array, expectedMime = 'video/mp4') {
  if (expectedMime !== 'video/mp4' || !input.length || input.length > MAX_VIDEO_BYTES) throw new Error(INVALID)
  const bytes = Buffer.from(input)
  const roots = boxes(bytes, 0, bytes.length)
  const ftyp = roots.find((item) => item.type === 'ftyp')
  const moov = roots.find((item) => item.type === 'moov')
  if (!ftyp || !moov || roots.some((item) => item.type === 'moof') || !roots.some((item) => item.type === 'mdat' && item.end > item.payload)) throw new Error(INVALID)
  need(ftyp, 8)
  let selected: { width: number; height: number; durationSeconds: number } | undefined
  for (const track of boxes(bytes, moov.payload, moov.end).filter((item) => item.type === 'trak')) {
    const mdia = child(bytes, track, 'mdia')
    const handler = child(bytes, mdia, 'hdlr'); need(handler, 12)
    if (bytes.toString('ascii', handler.payload + 8, handler.payload + 12) !== 'vide') continue
    const tkhd = child(bytes, track, 'tkhd')
    const version = bytes[tkhd.payload]
    const widthAt = version === 0 ? 76 : version === 1 ? 88 : -1
    if (widthAt < 0) throw new Error(INVALID)
    need(tkhd, widthAt + 8)
    let width = bytes.readUInt32BE(tkhd.payload + widthAt) / 65536
    let height = bytes.readUInt32BE(tkhd.payload + widthAt + 4) / 65536
    const matrix = tkhd.payload + widthAt - 36
    if (bytes.readInt32BE(matrix) === 0 && Math.abs(bytes.readInt32BE(matrix + 4)) === 65536) [width, height] = [height, width]
    const mdhd = child(bytes, mdia, 'mdhd')
    const timeVersion = bytes[mdhd.payload]
    need(mdhd, timeVersion === 1 ? 32 : 20)
    if (![0, 1].includes(timeVersion)) throw new Error(INVALID)
    const scale = bytes.readUInt32BE(mdhd.payload + (timeVersion === 1 ? 20 : 12))
    const duration = timeVersion === 1 ? Number(bytes.readBigUInt64BE(mdhd.payload + 24)) : bytes.readUInt32BE(mdhd.payload + 16)
    const durationSeconds = duration / scale
    const stsd = child(bytes, child(bytes, child(bytes, mdia, 'minf'), 'stbl'), 'stsd'); need(stsd, 16)
    const entries = boxes(bytes, stsd.payload + 8, stsd.end)
    if (!entries.length || entries.some((entry) => !['avc1', 'avc3'].includes(entry.type))) throw new Error(INVALID)
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 16 || height < 16 || width > 8192 || height > 8192 ||
      !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 12 * 3600) throw new Error(INVALID)
    if (selected) throw new Error(INVALID)
    selected = { width, height, durationSeconds }
  }
  if (!selected) throw new Error(INVALID)
  stripMetadata(bytes, roots)
  return { bytes, mime: 'video/mp4' as const, ...selected, sha256: createHash('sha256').update(bytes).digest('hex'), ext: 'mp4' }
}
