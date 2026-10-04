/**
 * The fake worker (task A3): drives the worker API through every delivery
 * state without Postiz, so each admin screen state can be shown on localhost.
 * It follows the real worker procedure of PRD 10.3 (recompute the hash,
 * /submitting before "creating", poll, reconcile) and picks outcomes from a
 * scenario instead of a platform.
 *
 * Scenarios for publish jobs:
 *   ok         submitting -> submitted; the next poll publishes it
 *   fail       submitting -> failed VALIDATION_REJECTED
 *   retry      failed before submitting: retry TRANSIENT (backoff, then again)
 *   unknown    submitting -> reconciling UNKNOWN_RESULT; reconcile decides later
 *   auth       failed AUTH_EXPIRED (the account goes to reconnect_required)
 *   lose-lease /submitting with a wrong attempt: the API answers 409
 *   random     one of the above, weighted towards ok
 * Reconcile jobs are found (-> submitted) or not found, at random unless
 * `reconcile` is forced. Poll jobs publish, or fail with `poll: 'fail'`.
 */

import { destinationHash } from '../hash.ts'
import type { WorkerApi } from './worker-api-client.ts'

export const PUBLISH_SCENARIOS = ['ok', 'fail', 'retry', 'unknown', 'auth', 'lose-lease', 'random'] as const
export type PublishScenario = (typeof PUBLISH_SCENARIOS)[number]

export interface FakeWorkerOptions {
  scenario?: PublishScenario
  reconcile?: 'found' | 'not_found' | 'random'
  poll?: 'publish' | 'fail'
  limit?: number
  random?: () => number
  log?: (line: string) => void
}

interface ClaimedJob {
  job_id: string
  kind: 'publish' | 'poll' | 'reconcile'
  attempt_no: number
  account: { id: string; platform: string; postiz_integration_id: string | null }
  destination: { id: string; text: string; settings: Record<string, unknown>; scheduled_at: string; destination_hash: string | null }
  media: Array<{ media_id: string; url: string | null; mime: string; sha256: string; alt_text: string }>
  postiz: { post_id: string; group: string | null } | null
}

export interface FakeWorkerStep {
  job_id: string
  kind: ClaimedJob['kind']
  action: string
  status: number
}

function pick(random: () => number): Exclude<PublishScenario, 'random'> {
  const r = random()
  if (r < 0.55) return 'ok'
  if (r < 0.67) return 'fail'
  if (r < 0.79) return 'retry'
  if (r < 0.91) return 'unknown'
  return 'auth'
}

export async function runFakeWorkerOnce(api: WorkerApi, opts: FakeWorkerOptions = {}): Promise<FakeWorkerStep[]> {
  const random = opts.random ?? Math.random
  const log = opts.log ?? (() => {})
  const steps: FakeWorkerStep[] = []
  const record = (job: ClaimedJob, action: string, status: number) => {
    steps.push({ job_id: job.job_id, kind: job.kind, action, status })
    log(`${job.kind.padEnd(9)} ${job.job_id.slice(0, 8)} ${job.account.platform.padEnd(13)} ${action} -> ${status}`)
  }
  const result = (job: ClaimedJob, body: Record<string, unknown>) =>
    api.post(`/deliveries/${job.job_id}/result`, { attempt_no: job.attempt_no, ...body })

  const claim = await api.post<{ jobs: ClaimedJob[] }>('/deliveries/claim', { limit: opts.limit ?? 5 })
  if (claim.status !== 200) throw new Error(`claim failed: ${claim.status} ${JSON.stringify(claim.body)}`)

  for (const job of claim.body.jobs) {
    if (job.kind === 'publish') {
      const recomputed = destinationHash({
        account_id: job.account.id,
        platform: job.account.platform,
        text: job.destination.text,
        settings: job.destination.settings,
        scheduled_at: job.destination.scheduled_at,
        media: job.media.map((m) => ({ sha256: m.sha256, alt_text: m.alt_text })),
      })
      if (recomputed !== job.destination.destination_hash) {
        const r = await result(job, { outcome: 'failed', error_code: 'HASH_MISMATCH', error_message: 'payload differs from approval' })
        record(job, 'failed HASH_MISMATCH', r.status)
        continue
      }
      const scenario = opts.scenario && opts.scenario !== 'random' ? opts.scenario : pick(random)
      if (scenario === 'lose-lease') {
        const r = await api.post(`/deliveries/${job.job_id}/submitting`, { attempt_no: job.attempt_no + 1 })
        record(job, 'submitting with a wrong attempt (expect 409)', r.status)
        continue
      }
      if (scenario === 'retry') {
        const r = await result(job, { outcome: 'retry', error_code: 'TRANSIENT', error_message: 'fake: Postiz 503' })
        record(job, 'retry TRANSIENT', r.status)
        continue
      }
      if (scenario === 'auth') {
        const r = await result(job, { outcome: 'failed', error_code: 'AUTH_EXPIRED', error_message: 'fake: token expired' })
        record(job, 'failed AUTH_EXPIRED', r.status)
        continue
      }
      const s = await api.post(`/deliveries/${job.job_id}/submitting`, { attempt_no: job.attempt_no })
      record(job, 'submitting', s.status)
      if (s.status !== 200) continue
      if (scenario === 'fail') {
        const r = await result(job, { outcome: 'failed', error_code: 'VALIDATION_REJECTED', error_message: 'fake: platform rejected the text' })
        record(job, 'failed VALIDATION_REJECTED', r.status)
      } else if (scenario === 'unknown') {
        const r = await result(job, { outcome: 'reconciling', error_code: 'UNKNOWN_RESULT', error_message: 'fake: connection dropped' })
        record(job, 'reconciling UNKNOWN_RESULT', r.status)
      } else {
        const r = await api.post(`/deliveries/${job.job_id}/submitted`, {
          attempt_no: job.attempt_no,
          postiz_post_id: `fake-${job.job_id.slice(0, 8)}-${job.attempt_no}`,
          postiz_group: `fake-group-${job.job_id.slice(0, 8)}`,
        })
        record(job, 'submitted', r.status)
      }
    } else if (job.kind === 'poll') {
      if (opts.poll === 'fail') {
        const r = await result(job, { outcome: 'failed', error_code: 'VALIDATION_REJECTED', error_message: 'fake: rejected after review' })
        record(job, 'poll -> failed', r.status)
      } else {
        const url = `https://example.com/fake/${job.account.platform}/${job.postiz?.post_id ?? job.job_id}`
        const r = await result(job, { outcome: 'published', remote_url: url })
        record(job, 'poll -> published', r.status)
      }
    } else {
      const found = opts.reconcile === 'found' || (opts.reconcile !== 'not_found' && random() < 0.5)
      if (found) {
        const r = await api.post(`/deliveries/${job.job_id}/submitted`, {
          attempt_no: job.attempt_no,
          postiz_post_id: `fake-found-${job.job_id.slice(0, 8)}`,
          postiz_group: null,
        })
        record(job, 'reconcile -> found (submitted)', r.status)
      } else {
        const r = await result(job, { outcome: 'not_found' })
        record(job, 'reconcile -> not_found', r.status)
      }
    }
  }
  return steps
}

/** Fake Postiz channels for /accounts/sync (one per automatic platform). */
export const FAKE_INTEGRATIONS = [
  { postiz_integration_id: 'fake-x', provider: 'x', name: 'Taxes Support (X, test)', rules: { max_length: 280 } },
  { postiz_integration_id: 'fake-linkedin', provider: 'linkedin-page', name: 'Taxes Support (LinkedIn, test)', rules: { max_length: 3000 } },
  { postiz_integration_id: 'fake-facebook', provider: 'facebook', name: 'Taxes Support (Facebook, test)', rules: {} },
  { postiz_integration_id: 'fake-instagram', provider: 'instagram-standalone', name: 'taxes.support.test (Instagram)', rules: { max_length: 2200 } },
  { postiz_integration_id: 'fake-devto', provider: 'devto', name: 'taxes-support-test (dev.to)', rules: {} },
  { postiz_integration_id: 'fake-hashnode', provider: 'hashnode', name: 'Taxes Support blog (Hashnode, test)', rules: {} },
]

export async function syncFakeAccounts(api: WorkerApi, opts: { refreshNeeded?: string[] } = {}) {
  return api.post('/accounts/sync', {
    integrations: FAKE_INTEGRATIONS.map((i) => ({
      ...i,
      picture_url: null,
      profile_url: null,
      disabled: false,
      refresh_needed: opts.refreshNeeded?.includes(i.postiz_integration_id) ?? false,
    })),
    postiz_recent_posts: [],
  })
}

/**
 * Concurrent claims from `n` workers at once; every job must come back to at
 * most one of them. Meaningful against real Postgres (local Supabase).
 */
export async function claimRace(api: WorkerApi, n: number): Promise<{ claimed: number; duplicates: string[] }> {
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) => api.withWorker(`race-${i}`).post<{ jobs: ClaimedJob[] }>('/deliveries/claim', { limit: 5 }))
  )
  const seen = new Map<string, number>()
  for (const r of results) for (const j of r.body.jobs ?? []) seen.set(j.job_id, (seen.get(j.job_id) ?? 0) + 1)
  return { claimed: seen.size, duplicates: [...seen].filter(([, c]) => c > 1).map(([id]) => id) }
}
