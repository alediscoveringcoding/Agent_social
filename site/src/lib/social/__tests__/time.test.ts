import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  bucharestDay,
  checkDailyCap,
  dayBoundsUtc,
  formatBucharest,
  offsetMinutes,
  toIsoSeconds,
  toLocalInputs,
  zonedLocalToUtc,
} from '../time.ts'

/**
 * Bucharest leaves summer time on Sunday 25 October 2026 (04:00 EEST -> 03:00
 * EET, at 01:00 UTC) and enters it on Sunday 28 March 2027 (03:00 EET ->
 * 04:00 EEST, at 01:00 UTC). The cap is per calendar day, so those two days
 * are 25 and 23 hours long (PRD 14, check 4).
 */

describe('Bucharest days', () => {
  it('maps instants to the local calendar day', () => {
    assert.equal(bucharestDay('2026-11-02T08:00:00Z'), '2026-11-02')
    assert.equal(bucharestDay('2026-11-01T22:30:00Z'), '2026-11-02') // 00:30 local
    assert.equal(bucharestDay('2026-11-01T21:59:59Z'), '2026-11-01')
  })

  it('knows the offset on both sides of each change', () => {
    assert.equal(offsetMinutes('2026-10-25T00:59:00Z'), 180)
    assert.equal(offsetMinutes('2026-10-25T01:00:00Z'), 120)
    assert.equal(offsetMinutes('2027-03-28T00:59:00Z'), 120)
    assert.equal(offsetMinutes('2027-03-28T01:00:00Z'), 180)
  })

  it('makes 25 October 2026 a 25-hour day and 28 March 2027 a 23-hour day', () => {
    const autumn = dayBoundsUtc('2026-10-25')
    assert.equal(autumn.start.toISOString(), '2026-10-24T21:00:00.000Z')
    assert.equal(autumn.end.toISOString(), '2026-10-25T22:00:00.000Z')
    assert.equal((autumn.end.getTime() - autumn.start.getTime()) / 3600000, 25)

    const spring = dayBoundsUtc('2027-03-28')
    assert.equal(spring.start.toISOString(), '2027-03-27T22:00:00.000Z')
    assert.equal(spring.end.toISOString(), '2027-03-28T21:00:00.000Z')
    assert.equal((spring.end.getTime() - spring.start.getTime()) / 3600000, 23)
  })

  it('places the first and last minute of the long day on that day', () => {
    assert.equal(bucharestDay('2026-10-24T21:00:00Z'), '2026-10-25') // 00:00 EEST
    assert.equal(bucharestDay('2026-10-25T21:59:00Z'), '2026-10-25') // 23:59 EET
    assert.equal(bucharestDay('2026-10-25T22:00:00Z'), '2026-10-26')
  })
})

describe('zonedLocalToUtc', () => {
  it('converts an ordinary winter and summer time', () => {
    assert.equal(zonedLocalToUtc('2026-11-02', '10:00').toISOString(), '2026-11-02T08:00:00.000Z')
    assert.equal(zonedLocalToUtc('2026-07-01', '09:00').toISOString(), '2026-07-01T06:00:00.000Z')
  })
  it('takes the FIRST of a repeated time in October', () => {
    assert.equal(zonedLocalToUtc('2026-10-25', '03:30').toISOString(), '2026-10-25T00:30:00.000Z')
    assert.equal(zonedLocalToUtc('2026-10-25', '04:00').toISOString(), '2026-10-25T02:00:00.000Z')
  })
  it('moves a time that does not exist in March forward by the gap', () => {
    assert.equal(zonedLocalToUtc('2027-03-28', '03:30').toISOString(), '2027-03-28T01:30:00.000Z')
    assert.deepEqual(toLocalInputs('2027-03-28T01:30:00Z'), { date: '2027-03-28', time: '04:30' })
  })
  it('round-trips through the form inputs', () => {
    const at = zonedLocalToUtc('2026-12-24', '18:45')
    assert.deepEqual(toLocalInputs(at), { date: '2026-12-24', time: '18:45' })
  })
  it('refuses malformed input', () => {
    assert.throws(() => zonedLocalToUtc('2026-13-01x', '10:00'))
    assert.throws(() => zonedLocalToUtc('2026-11-01', '25:00'))
  })
})

describe('checkDailyCap (max 5 per account per Bucharest day)', () => {
  const acc = 'acc-1'
  const at = (iso: string) => ({ accountId: acc, scheduledAt: iso })

  it('allows the fifth and blocks the sixth on an ordinary day', () => {
    const four = ['06:00', '08:00', '10:00', '12:00'].map((t) => at(`2026-11-02T${t}:00Z`))
    assert.deepEqual(checkDailyCap(four, [at('2026-11-02T14:00:00Z')]), [])
    const five = [...four, at('2026-11-02T14:00:00Z')]
    assert.deepEqual(checkDailyCap(five, [at('2026-11-02T16:00:00Z')]), [
      { accountId: acc, day: '2026-11-02', used: 5, adding: 1, cap: 5 },
    ])
  })

  it('counts the whole 25-hour October day as ONE day across the DST change', () => {
    // 00:30 EEST, 03:30 EEST, 03:30 EET (the repeated hour), 12:00 EET, 23:30 EET
    const five = [
      at('2026-10-24T21:30:00Z'),
      at('2026-10-25T00:30:00Z'),
      at('2026-10-25T01:30:00Z'),
      at('2026-10-25T10:00:00Z'),
      at('2026-10-25T21:30:00Z'),
    ]
    assert.ok(five.every((i) => bucharestDay(i.scheduledAt) === '2026-10-25'))
    const sixth = checkDailyCap(five, [at('2026-10-25T21:59:00Z')])
    assert.deepEqual(sixth, [{ accountId: acc, day: '2026-10-25', used: 5, adding: 1, cap: 5 }])
    // Just after local midnight is the next day, which is free.
    assert.deepEqual(checkDailyCap(five, [at('2026-10-25T22:00:00Z')]), [])
  })

  it('counts the 23-hour March day correctly too', () => {
    const five = [
      at('2027-03-27T22:00:00Z'), // 00:00 EET
      at('2027-03-28T00:59:00Z'), // 02:59 EET
      at('2027-03-28T01:00:00Z'), // 04:00 EEST
      at('2027-03-28T12:00:00Z'),
      at('2027-03-28T20:59:00Z'), // 23:59 EEST
    ]
    assert.ok(five.every((i) => bucharestDay(i.scheduledAt) === '2027-03-28'))
    assert.equal(checkDailyCap(five, [at('2027-03-28T15:00:00Z')]).length, 1)
    assert.deepEqual(checkDailyCap(five, [at('2027-03-28T21:00:00Z')]), [])
  })

  it('uses a lower per-account cap, never a higher one', () => {
    const two = [at('2026-11-02T06:00:00Z'), at('2026-11-02T08:00:00Z')]
    assert.equal(checkDailyCap(two, [at('2026-11-02T10:00:00Z')], { [acc]: 2 }).length, 1)
    const five = Array.from({ length: 5 }, (_, i) => at(`2026-11-02T0${i + 1}:00:00Z`))
    assert.equal(checkDailyCap(five, [at('2026-11-02T10:00:00Z')], { [acc]: 9 }).length, 1)
  })

  it('counts several new destinations on the same day together', () => {
    const three = [at('2026-11-02T06:00:00Z'), at('2026-11-02T07:00:00Z'), at('2026-11-02T08:00:00Z')]
    assert.equal(checkDailyCap(three, [at('2026-11-02T09:00:00Z'), at('2026-11-02T10:00:00Z')]).length, 0)
    assert.equal(
      checkDailyCap(three, [at('2026-11-02T09:00:00Z'), at('2026-11-02T10:00:00Z'), at('2026-11-02T11:00:00Z')])
        .length,
      1
    )
  })
})

describe('formatting', () => {
  it('shows Bucharest time and ISO seconds', () => {
    assert.match(formatBucharest('2026-11-02T08:00:00Z'), /10:00/)
    assert.equal(formatBucharest(null), '-')
    assert.equal(toIsoSeconds('2026-11-02T08:00:00.987Z'), '2026-11-02T08:00:00Z')
  })
})
