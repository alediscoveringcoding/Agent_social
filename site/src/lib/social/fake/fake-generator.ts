/**
 * The fake generator (task A3): claims generation requests like Track B's
 * generator and delivers fixture drafts instead of calling Claude, including
 * drafts that fail the content rules, so the drafts inbox and the composer's
 * validation can be exercised on localhost.
 */

import { draftsFor } from './fixtures.ts'
import type { WorkerApi } from './worker-api-client.ts'

interface ClaimedRequest {
  request_id: string
  brand: string
  input: { platforms?: string[]; count?: number }
}

export interface FakeGeneratorResult {
  request_id: string
  status: number
  body: Record<string, unknown>
}

export async function runFakeGeneratorOnce(
  api: WorkerApi,
  opts: { fail?: boolean; log?: (line: string) => void } = {}
): Promise<FakeGeneratorResult[]> {
  const log = opts.log ?? (() => {})
  const claim = await api.post<{ requests: ClaimedRequest[] }>('/generation/claim', { limit: 1 })
  if (claim.status !== 200) throw new Error(`generation claim failed: ${claim.status} ${JSON.stringify(claim.body)}`)
  const out: FakeGeneratorResult[] = []
  for (const req of claim.body.requests) {
    if (opts.fail) {
      const r = await api.post(`/generation/${req.request_id}/failed`, {
        error_code: 'FAKE_FAILURE',
        error_message: 'fake generator: asked to fail',
      })
      log(`request ${req.request_id.slice(0, 8)} -> failed (${r.status})`)
      out.push({ request_id: req.request_id, status: r.status, body: r.body })
      continue
    }
    const platforms = req.input.platforms?.length ? req.input.platforms : ['x', 'linkedin-page']
    const count = Math.min(Math.max(req.input.count ?? 3, 1), 20)
    const drafts = draftsFor(platforms, count).map((d) => ({
      ...d,
      card: d.card ? { ...d.card, brand: req.brand } : d.card,
    }))
    const r = await api.post(`/generation/${req.request_id}/drafts`, { drafts })
    log(`request ${req.request_id.slice(0, 8)} (${req.brand}) -> ${drafts.length} drafts: ${r.status} ${JSON.stringify(r.body)}`)
    out.push({ request_id: req.request_id, status: r.status, body: r.body })
  }
  return out
}
