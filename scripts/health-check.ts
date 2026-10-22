#!/usr/bin/env -S node --experimental-strip-types --no-warnings
// Checks that the site and the worker answer. Exits 1 when one of them is down.

interface Result { name: string; up: boolean; code?: number; error: string }

async function check(name: string, url: string): Promise<Result> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    return { name, up: res.ok, code: res.status, error: res.ok ? '' : `HTTP ${res.status}` }
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } }
    return { name, up: false, error: e.cause?.code || e.message }
  }
}

const checks = await Promise.all([
  check('Site', 'http://127.0.0.1:3000/login'),
  check('Worker', 'http://127.0.0.1:8787/health'),
])

console.log('=== Health Check ===\n')
for (const c of checks) console.log(`  ${c.up ? 'OK  ' : 'DOWN'} ${c.name}: ${c.up ? `UP (${c.code})` : `DOWN - ${c.error}`}`)
if (checks.some((c) => !c.up)) {
  console.error('\nA service is down.')
  process.exitCode = 1
}
