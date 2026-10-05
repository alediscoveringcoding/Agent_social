/**
 * Content hashes (PRD 10.6). The approval binds these, and the worker
 * recomputes `destination_hash` from the delivery payload before publishing
 * (HASH_MISMATCH otherwise), so both sides must produce the same bytes:
 *
 *   destination_hash = sha256_hex(JCS({ account_id, platform, text, settings,
 *                        scheduled_at, media: [{ sha256, alt_text }, ...] }))
 *   approval_hash    = sha256_hex(JCS({ post_id, revision_id,
 *                        destinations: [destination_hash, ...] }))
 *
 * - JCS is RFC 8785, via the `canonicalize` package (the same one the worker uses).
 * - `scheduled_at` is ISO 8601 UTC truncated to the second, with a `Z`:
 *   "2026-11-02T08:00:00Z". Milliseconds are dropped, not rounded.
 * - `media` is in position order; `alt_text` is the per-attachment alt text.
 * - `destinations` in the approval hash are ordered by destination id
 *   (lowercase UUID strings compared by code unit, i.e. byte order).
 * - Text is hashed exactly as stored: no Unicode normalization, no trimming.
 *
 * Shared test vectors: `__tests__/hash-vectors.json`, mirrored in the infra
 * repo at docs/contracts/hash-vectors.json. Server-only (node:crypto).
 */

import { createHash } from 'node:crypto'
import canonicalize from 'canonicalize'

export interface HashMedia {
  sha256: string
  alt_text: string
}

export interface DestinationHashInput {
  account_id: string
  platform: string
  text: string
  settings: Record<string, unknown>
  /** Any instant; normalized with `toHashTimestamp`. */
  scheduled_at: string | Date
  /** In position order. */
  media: ReadonlyArray<HashMedia>
}

export interface ApprovalHashInput {
  post_id: string
  revision_id: string
  destinations: ReadonlyArray<{ id: string; destination_hash: string }>
}

/** "2026-11-02T08:00:00Z": UTC, whole seconds (truncated), `Z` suffix. */
export function toHashTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value)
  const ms = date.getTime()
  if (!Number.isFinite(ms)) {
    throw new Error(`toHashTimestamp: not a valid instant: ${String(value)}`)
  }
  const truncated = new Date(Math.floor(ms / 1000) * 1000)
  return truncated.toISOString().replace('.000Z', 'Z')
}

function jcs(value: unknown): string {
  const out = canonicalize(value)
  if (out === undefined) throw new Error('JCS: value cannot be canonicalized')
  return out
}

/** Plain JSON data: drops `undefined`, rejects what JSON cannot carry. */
function plainJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The exact object that is hashed for a destination. */
export function destinationHashObject(input: DestinationHashInput) {
  return {
    account_id: input.account_id,
    platform: input.platform,
    text: input.text,
    settings: plainJson(input.settings ?? {}),
    scheduled_at: toHashTimestamp(input.scheduled_at),
    media: input.media.map((m) => ({ sha256: m.sha256, alt_text: m.alt_text })),
  }
}

export function canonicalDestination(input: DestinationHashInput): string {
  return jcs(destinationHashObject(input))
}

export function destinationHash(input: DestinationHashInput): string {
  return sha256Hex(canonicalDestination(input))
}

function byIdAscending(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function canonicalApproval(input: ApprovalHashInput): string {
  const ordered = [...input.destinations].sort(byIdAscending)
  return jcs({
    post_id: input.post_id,
    revision_id: input.revision_id,
    destinations: ordered.map((d) => d.destination_hash),
  })
}

export function approvalHash(input: ApprovalHashInput): string {
  return sha256Hex(canonicalApproval(input))
}

export function sha256OfBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
