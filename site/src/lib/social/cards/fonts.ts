/**
 * Plus Jakarta Sans for the card renderer (PRD 8.3: 400/600/700/800), read
 * from @fontsource at runtime. Satori takes woff (not woff2). latin-ext is
 * loaded too, so a stray diacritic renders instead of making the renderer
 * look for a font on the network. next.config.ts traces these files.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CARD_FONT_FAMILY = 'Plus Jakarta Sans'
const WEIGHTS = [400, 600, 700, 800] as const
const SUBSETS = ['latin', 'latin-ext'] as const

export interface CardFont {
  name: string
  data: ArrayBuffer
  weight: (typeof WEIGHTS)[number]
  style: 'normal'
}

let cached: Promise<CardFont[]> | null = null

function fontDir(): string {
  return join(process.cwd(), 'node_modules', '@fontsource', 'plus-jakarta-sans', 'files')
}

async function load(): Promise<CardFont[]> {
  const out: CardFont[] = []
  for (const subset of SUBSETS) {
    for (const weight of WEIGHTS) {
      const buf = await readFile(join(fontDir(), `plus-jakarta-sans-${subset}-${weight}-normal.woff`))
      out.push({
        name: CARD_FONT_FAMILY,
        data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
        weight,
        style: 'normal',
      })
    }
  }
  return out
}

export function cardFonts(): Promise<CardFont[]> {
  cached ??= load().catch((e) => {
    cached = null
    throw e
  })
  return cached
}
