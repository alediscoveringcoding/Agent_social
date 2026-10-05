/**
 * Server-side card rendering (F3): the card spec as a PNG in one of the six
 * formats (PRD 10.5), with next/og (Satori + Resvg) and Plus Jakarta Sans.
 * The stored card is a media object like an upload (sha256, size, alt text),
 * so it is part of the destination hash.
 */

import { ImageResponse } from 'next/og'
import { CARD_FORMATS, type CardFormat } from '../constants.ts'
import { cardFonts } from './fonts.ts'
import { cardElement } from './layout.ts'
import type { CardBrand } from './palette.ts'
import type { CardSpec } from './spec.ts'

export interface RenderedCard {
  bytes: Buffer
  mime: 'image/png'
  width: number
  height: number
  format: CardFormat
}

export async function renderCardPng(spec: CardSpec, format: CardFormat, brand: CardBrand): Promise<RenderedCard> {
  const { width, height } = CARD_FORMATS[format]
  const res = new ImageResponse(cardElement(spec, format, brand), {
    width,
    height,
    fonts: await cardFonts(),
  })
  if (!res.ok) throw new Error(`card render failed: ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length === 0) throw new Error('card render produced no bytes')
  return { bytes, mime: 'image/png', width, height, format }
}
