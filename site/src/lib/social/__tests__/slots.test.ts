import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SLOTS, parseSlots, suggestSlots } from '../slots.ts'
import { localToInstant } from '../approval.ts'

const account = [{ id: 'account', cap: 5 }]
describe('Bucharest scheduling slots', () => {
  it('parses, sorts and deduplicates valid slots', () => {
    assert.deepEqual(parseSlots('18:00, 9:00; 09:00 13:00 nope 24:00 09:60'), [...DEFAULT_SLOTS])
    assert.deepEqual(parseSlots(null), [])
  })
  it('keeps a 15-minute lead and uses the next free slot per account', () => {
    const [next] = suggestSlots(account, [], { now: new Date('2026-11-02T06:50:00Z') })
    assert.equal(next.at, '2026-11-02T11:00:00.000Z')
    assert.equal(suggestSlots(account, [], { now: new Date('2026-11-02T06:45:00Z') })[0].time, '09:00')
  })
  it('keeps a 60-minute gap, including bookings from the previous day', () => {
    const now = new Date('2026-11-01T21:00:00Z')
    const booked = [{ accountId: 'account', runAt: '2026-11-01T21:45:00Z' }]
    assert.equal(suggestSlots(account, booked, { now, slots: ['00:15', '01:00'] })[0].time, '01:00')
  })
  it('counts the cap by calendar day and independently per account', () => {
    const next = suggestSlots([{ id: 'account', cap: 1 }, { id: 'other', cap: 1 }], [{ accountId: 'account', runAt: '2026-11-02T16:00:00Z' }], { now: new Date('2026-11-02T06:00:00Z') })
    assert.equal(next[0].date, '2026-11-03')
    assert.equal(next[1].date, '2026-11-02')
  })
  it('returns no slot when the horizon is full or all slots are invalid', () => {
    assert.equal(suggestSlots(account, [], { now: new Date('2026-11-02T18:00:00Z'), horizonDays: 0 })[0].at, null)
    assert.equal(suggestSlots(account, [], { slots: ['bad'] })[0].at, null)
  })
  it('uses the first October occurrence and moves a March gap forward', () => {
    assert.equal(localToInstant({ date: '2026-10-25', time: '03:30' })!.toISOString(), '2026-10-25T00:30:00.000Z')
    const gap = suggestSlots(account, [], { now: new Date('2026-03-28T22:00:00Z'), slots: ['03:30'] })[0]
    assert.equal(gap.at, '2026-03-29T01:30:00.000Z')
    assert.equal(gap.time, '04:30')
  })
})
