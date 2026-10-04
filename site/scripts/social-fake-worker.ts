/**
 * Fake worker for localhost (task A3). Talks to the running site over HTTP,
 * like Track B's worker, and needs no Postiz.
 *
 *   npm run social:fake-worker                      # loop every 10 s, random outcomes
 *   npm run social:fake-worker -- --once --scenario ok
 *   npm run social:fake-worker -- --scenario unknown --reconcile not_found
 *   npm run social:fake-worker -- --sync            # register fake Postiz channels
 *   npm run social:fake-worker -- --sync --refresh fake-x   # mark one as needing reconnect
 *   npm run social:fake-worker -- --race 8          # concurrent claims, expect no duplicates
 *
 * Env (from .env.local): SITE_BASE_URL (default http://localhost:3000), WORKER_TOKEN.
 * Remember SOCIAL_PUBLISHING_ENABLED=true in the SITE's env, or claims return nothing.
 */

import { parseArgs } from 'node:util'
import { PUBLISH_SCENARIOS, claimRace, runFakeWorkerOnce, syncFakeAccounts, type PublishScenario } from '../src/lib/social/fake/fake-worker.ts'
import { WorkerApi } from '../src/lib/social/fake/worker-api-client.ts'

const { values } = parseArgs({
  options: {
    once: { type: 'boolean', default: false },
    scenario: { type: 'string', default: 'random' },
    reconcile: { type: 'string', default: 'random' },
    poll: { type: 'string', default: 'publish' },
    interval: { type: 'string', default: '10' },
    sync: { type: 'boolean', default: false },
    refresh: { type: 'string', multiple: true, default: [] },
    race: { type: 'string' },
    worker: { type: 'string', default: 'fake-worker-1' },
  },
})

const token = process.env.WORKER_TOKEN
if (!token) {
  console.error('WORKER_TOKEN is not set (put it in .env.local, same value as the site).')
  process.exit(1)
}
if (!(PUBLISH_SCENARIOS as readonly string[]).includes(values.scenario!)) {
  console.error(`--scenario must be one of: ${PUBLISH_SCENARIOS.join(', ')}`)
  process.exit(1)
}

const api = new WorkerApi({
  baseUrl: process.env.SITE_BASE_URL ?? 'http://localhost:3000',
  token,
  workerId: values.worker!,
  version: 'fake-worker/0.1',
})

const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`)

async function main() {
  if (values.sync) {
    const r = await syncFakeAccounts(api, { refreshNeeded: values.refresh })
    log(`accounts/sync -> ${r.status} ${JSON.stringify(r.body)}`)
    return
  }
  if (values.race) {
    const n = Math.max(2, Number(values.race))
    const r = await claimRace(api, n)
    log(`${n} concurrent claims: ${r.claimed} jobs claimed, duplicates: ${r.duplicates.length ? r.duplicates.join(', ') : 'none'}`)
    process.exitCode = r.duplicates.length ? 1 : 0
    return
  }
  const opts = {
    scenario: values.scenario as PublishScenario,
    reconcile: values.reconcile as 'found' | 'not_found' | 'random',
    poll: values.poll as 'publish' | 'fail',
    log,
  }
  do {
    const steps = await runFakeWorkerOnce(api, opts)
    if (!steps.length) log('nothing due')
    if (values.once) break
    await new Promise((r) => setTimeout(r, Number(values.interval) * 1000))
  } while (true)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
