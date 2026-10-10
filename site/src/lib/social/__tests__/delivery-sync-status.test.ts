import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { syncedStatus } from '../sync-rules.ts'

describe('syncedStatus never reads silence as a recovery', () => {
  it('keeps reconnect_required unless Postiz says the channel is fine', () => {
    assert.equal(syncedStatus('reconnect_required', undefined), 'reconnect_required')
    assert.equal(syncedStatus('reconnect_required', false), 'connected')
    assert.equal(syncedStatus('reconnect_required', true), 'reconnect_required')
  })

  it('a channel new to the site connects, and other states are kept', () => {
    assert.equal(syncedStatus(null, undefined), 'connected')
    assert.equal(syncedStatus(null, false), 'connected')
    assert.equal(syncedStatus('connected', undefined), 'connected')
    assert.equal(syncedStatus('connected', true), 'reconnect_required')
    assert.equal(syncedStatus('manual', true), 'manual')
    assert.equal(syncedStatus('developer_setup_required', undefined), 'developer_setup_required')
  })
})
