import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AdminAuthError, adminDecision, hasVerifiedTotp, isAllowedEmail, parseAdminEmails, safeNext } from '../decision.ts'

const allow = parseAdminEmails(' Admin@Example.com, ops@example.com ,not-an-email,')

describe('admin access decision (amendment 02)', () => {
  it('parses the allowlist case-insensitively and drops junk', () => {
    assert.deepEqual(allow, ['admin@example.com', 'ops@example.com'])
    assert.equal(isAllowedEmail('ADMIN@example.com', allow), true)
    assert.equal(isAllowedEmail('other@example.com', allow), false)
  })

  it('fails closed with no allowlist', () => {
    assert.equal(adminDecision({ email: 'admin@example.com', allowlist: parseAdminEmails(undefined), hasVerifiedTotp: true, aal: 'aal2' }), 'forbidden')
  })

  it('walks login -> forbidden -> enroll -> verify -> ok', () => {
    const base = { allowlist: allow, hasVerifiedTotp: true, aal: 'aal2' }
    assert.equal(adminDecision({ ...base, email: null }), 'login')
    assert.equal(adminDecision({ ...base, email: 'x@example.com' }), 'forbidden')
    assert.equal(adminDecision({ ...base, email: 'admin@example.com', hasVerifiedTotp: false }), 'enroll')
    assert.equal(adminDecision({ ...base, email: 'admin@example.com', aal: 'aal1' }), 'verify')
    assert.equal(adminDecision({ ...base, email: 'admin@example.com' }), 'ok')
  })

  it('asks to enrol again when the factor is gone even if the token still says aal2', () => {
    assert.equal(adminDecision({ email: 'admin@example.com', allowlist: allow, hasVerifiedTotp: false, aal: 'aal2' }), 'enroll')
  })

  it('only counts verified TOTP factors', () => {
    assert.equal(hasVerifiedTotp([{ factor_type: 'totp', status: 'unverified' }]), false)
    assert.equal(hasVerifiedTotp([{ factor_type: 'phone', status: 'verified' }]), false)
    assert.equal(hasVerifiedTotp([{ factor_type: 'totp', status: 'verified' }]), true)
    assert.equal(hasVerifiedTotp(undefined), false)
  })

  it('keeps redirects on /admin paths of this site', () => {
    assert.equal(safeNext('/admin/social/ciorne'), '/admin/social/ciorne')
    assert.equal(safeNext('https://evil.example/admin'), '/admin/social')
    assert.equal(safeNext('//evil.example'), '/admin/social')
    assert.equal(safeNext('/login'), '/admin/social')
    assert.equal(safeNext(null), '/admin/social')
  })

  it('carries a readable message', () => {
    const e = new AdminAuthError('verify')
    assert.equal(e.decision, 'verify')
    assert.match(e.message, /codul/)
  })
})
