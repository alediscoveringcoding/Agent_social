/**
 * Fake generator for localhost (task A3): claims generation requests created
 * in /admin/social/genereaza and delivers fixture drafts (some deliberately
 * invalid) instead of calling Claude. A request with web research on ("Cauta
 * pe web", or the recent-news source) also gets 3 sample sources (example.com)
 * and one unverified figure with a source link.
 *
 *   npm run social:fake-generator             # loop every 10 s
 *   npm run social:fake-generator -- --once
 *   npm run social:fake-generator -- --once --fail   # report the request as failed
 *
 * Env (from .env.local): SITE_BASE_URL (default http://localhost:3000), WORKER_TOKEN.
 */

import { parseArgs } from 'node:util'
import { runFakeGeneratorOnce } from '../src/lib/social/fake/fake-generator.ts'
import { WorkerApi } from '../src/lib/social/fake/worker-api-client.ts'

const { values } = parseArgs({
  options: {
    once: { type: 'boolean', default: false },
    fail: { type: 'boolean', default: false },
    interval: { type: 'string', default: '10' },
    worker: { type: 'string', default: 'fake-generator-1' },
  },
})

const token = process.env.WORKER_TOKEN
if (!token) {
  console.error('WORKER_TOKEN is not set (put it in .env.local, same value as the site).')
  process.exit(1)
}

const api = new WorkerApi({
  baseUrl: process.env.SITE_BASE_URL ?? 'http://localhost:3000',
  token,
  workerId: values.worker!,
  version: 'fake-generator/0.1',
})

const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`)

async function main() {
  do {
    const done = await runFakeGeneratorOnce(api, { fail: values.fail, log })
    if (!done.length) log('no generation request queued')
    if (values.once) break
    await new Promise((r) => setTimeout(r, Number(values.interval) * 1000))
  } while (true)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
