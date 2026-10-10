import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTags, tagsToText, altIsAuto, altMissesFigure, halfFilledTime } from '../../../app/admin/social/ciorne/[id]/ui-helpers.ts'

test('parseTags trims and drops empties', () => {
  assert.deepEqual(parseTags('foo, bar,, baz '), ['foo', 'bar', 'baz'])
  assert.deepEqual(parseTags('foo,'), ['foo'])
  assert.deepEqual(parseTags(''), [])
})

test('tagsToText handles arrays, strings and nothing', () => {
  assert.equal(tagsToText(['a', 'b']), 'a, b')
  assert.equal(tagsToText('x'), 'x')
  assert.equal(tagsToText(undefined), '')
})

test('altIsAuto only while untouched', () => {
  assert.equal(altIsAuto('Card A', 'Card A'), true)
  assert.equal(altIsAuto('', 'Card A'), true)
  assert.equal(altIsAuto('Scris de mana', 'Card A'), false)
})

test('altMissesFigure warns only when a figure is absent from the alt', () => {
  assert.equal(altMissesFigure('Cifra: 16%.', '16%'), false)
  assert.equal(altMissesFigure('Fara cifra', '16%'), true)
  assert.equal(altMissesFigure('orice', ''), false)
  assert.equal(altMissesFigure('orice', undefined), false)
})

test('halfFilledTime detects a single blank field', () => {
  assert.equal(halfFilledTime({ date: '2026-01-01', time: '' }), true)
  assert.equal(halfFilledTime({ date: '', time: '09:00' }), true)
  assert.equal(halfFilledTime({ date: '', time: '' }), false)
  assert.equal(halfFilledTime({ date: '2026-01-01', time: '09:00' }), false)
})
