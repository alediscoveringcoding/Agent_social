import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  approvalHash,
  canonicalApproval,
  canonicalDestination,
  destinationHash,
  toHashTimestamp,
  type ApprovalHashInput,
  type DestinationHashInput,
} from '../hash.ts'

/**
 * PRD 10.6. These vectors are the contract with the worker (Track B), which
 * recomputes destination_hash before every publish and refuses on a mismatch.
 * The same file lives in the infra repo as docs/contracts/hash-vectors.json;
 * both implementations must pass it. Never regenerate the expected values from
 * the code under test to make a failure go away: a changed hash means every
 * approved post in the queue would fail HASH_MISMATCH.
 */

interface Vectors {
  destination: Array<{ name: string; input: DestinationHashInput; canonical: string; hash: string }>
  approval: Array<{ name: string; input: ApprovalHashInput; canonical: string; hash: string }>
  timestamp_normalization: Array<{ input: string; expected: string }>
}

const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, 'hash-vectors.json'), 'utf8')
) as Vectors

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

describe('hash vectors (shared with the worker)', () => {
  it('has at least five destination vectors covering the required cases', () => {
    assert.ok(vectors.destination.length >= 5)
    const names = vectors.destination.map((v) => v.name).join(' ')
    for (const needle of ['romanian', 'emoji', 'empty-settings', 'multiple-images']) {
      assert.ok(names.includes(needle), `no vector for ${needle}`)
    }
  })

  it('is the same file as docs/contracts/hash-vectors.json (the copy Track B tests against)', () => {
    const contract = join(import.meta.dirname, '..', '..', '..', '..', '..', 'docs', 'contracts', 'hash-vectors.json')
    assert.deepEqual(JSON.parse(readFileSync(contract, 'utf8')), vectors)
  })

  for (const v of vectors.destination) {
    it(`destination: ${v.name}`, () => {
      assert.equal(canonicalDestination(v.input), v.canonical)
      assert.equal(destinationHash(v.input), v.hash)
      assert.equal(sha256(v.canonical), v.hash, 'hash is sha256 of the canonical UTF-8 bytes')
    })
  }

  for (const v of vectors.approval) {
    it(`approval: ${v.name}`, () => {
      assert.equal(canonicalApproval(v.input), v.canonical)
      assert.equal(approvalHash(v.input), v.hash)
      assert.equal(sha256(v.canonical), v.hash)
    })
  }

  for (const t of vectors.timestamp_normalization) {
    it(`scheduled_at ${t.input} -> ${t.expected}`, () => {
      assert.equal(toHashTimestamp(t.input), t.expected)
    })
  }
})

describe('destinationHash', () => {
  const base: DestinationHashInput = {
    account_id: '0b6f3c2a-6a51-4c1e-9d2f-1f0e8a7b6c5d',
    platform: 'x',
    text: 'Salut',
    settings: { b: 1, a: { d: 2, c: [3, 'x'] } },
    scheduled_at: '2026-11-02T08:00:00Z',
    media: [
      { sha256: 'a'.repeat(64), alt_text: 'unu' },
      { sha256: 'b'.repeat(64), alt_text: 'doi' },
    ],
  }

  it('matches a canonical string written out by hand (independent of the JCS library)', () => {
    const expected =
      '{"account_id":"0b6f3c2a-6a51-4c1e-9d2f-1f0e8a7b6c5d",' +
      `"media":[{"alt_text":"unu","sha256":"${'a'.repeat(64)}"},{"alt_text":"doi","sha256":"${'b'.repeat(64)}"}],` +
      '"platform":"x","scheduled_at":"2026-11-02T08:00:00Z",' +
      '"settings":{"a":{"c":[3,"x"],"d":2},"b":1},"text":"Salut"}'
    assert.equal(canonicalDestination(base), expected)
    assert.equal(destinationHash(base), sha256(expected))
  })

  it('does not depend on the key order of settings', () => {
    const reordered = { ...base, settings: { a: { c: [3, 'x'], d: 2 }, b: 1 } }
    assert.equal(destinationHash(reordered), destinationHash(base))
  })

  it('changes with the media order, an alt text, the text or the time', () => {
    const h = destinationHash(base)
    assert.notEqual(destinationHash({ ...base, media: [...base.media].reverse() }), h)
    assert.notEqual(destinationHash({ ...base, media: [base.media[0], { ...base.media[1], alt_text: 'trei' }] }), h)
    assert.notEqual(destinationHash({ ...base, text: 'Salut!' }), h)
    assert.notEqual(destinationHash({ ...base, scheduled_at: '2026-11-02T08:01:00Z' }), h)
  })

  it('treats the same instant written differently as the same time', () => {
    const h = destinationHash(base)
    assert.equal(destinationHash({ ...base, scheduled_at: '2026-11-02T10:00:00+02:00' }), h)
    assert.equal(destinationHash({ ...base, scheduled_at: new Date('2026-11-02T08:00:00.400Z') }), h)
  })

  it('ignores undefined keys in settings, as JSON would', () => {
    assert.equal(destinationHash({ ...base, settings: { ...base.settings, gone: undefined } }), destinationHash(base))
  })

  it('refuses an invalid time instead of hashing "Invalid Date"', () => {
    assert.throws(() => destinationHash({ ...base, scheduled_at: 'not a date' }))
  })
})

describe('approvalHash', () => {
  it('orders destinations by id, whatever order they come in', () => {
    const input: ApprovalHashInput = {
      post_id: 'p',
      revision_id: 'r',
      destinations: [
        { id: 'b', destination_hash: '2'.repeat(64) },
        { id: 'a', destination_hash: '1'.repeat(64) },
      ],
    }
    const flipped = { ...input, destinations: [...input.destinations].reverse() }
    assert.equal(approvalHash(input), approvalHash(flipped))
    assert.equal(
      canonicalApproval(input),
      `{"destinations":["${'1'.repeat(64)}","${'2'.repeat(64)}"],"post_id":"p","revision_id":"r"}`
    )
  })
})
