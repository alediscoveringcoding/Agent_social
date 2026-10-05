import sharp from 'sharp'
import { createHash } from 'node:crypto'

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
export function imageMime(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes)
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}
export async function ingestImage(input: Uint8Array, expectedMime?: string) {
  if (!input.length || input.length > MAX_UPLOAD_BYTES) throw new Error('Imaginea trebuie sa aiba cel mult 8 MB.')
  const mime = imageMime(input)
  if (!mime || (expectedMime && mime !== expectedMime)) throw new Error('Fisierul trebuie sa fie JPEG, PNG sau WebP, cu tipul corect.')
  const source = sharp(input, { limitInputPixels: 40_000_000, failOn: 'warning', animated: false })
  const metadata = await source.metadata()
  if ((metadata.pages ?? 1) > 1) throw new Error('Foloseste o imagine statica.')
  const format = mime === 'image/jpeg' ? 'jpeg' : mime === 'image/webp' ? 'webp' : 'png'
  // rotate applies EXIF orientation; default output removes EXIF, GPS, XMP and ICC.
  const { data: bytes, info } = await source.rotate().toFormat(format).toBuffer({ resolveWithObject: true })
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('Imaginea procesata depaseste 8 MB.')
  return { bytes, mime, width: info.width, height: info.height, sha256: createHash('sha256').update(bytes).digest('hex'), ext: format === 'jpeg' ? 'jpg' : format }
}

/** Stop reading oversized chunked bodies before buffering the entire request. */
export async function readUploadBody(request: Request): Promise<Uint8Array> {
  const length = request.headers.get('content-length')
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_UPLOAD_BYTES)) throw new Error('Imaginea depaseste 8 MB.')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('Fisierul lipseste.')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_UPLOAD_BYTES) { await reader.cancel(); throw new Error('Imaginea depaseste 8 MB.') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks)
}
