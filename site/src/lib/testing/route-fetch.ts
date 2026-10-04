/**
 * A `fetch` that answers worker API URLs with the real route handlers, in
 * process. Lets the fake worker / fake generator run in tests exactly as they
 * run against `npm run dev`, minus the network.
 */

import * as claim from '@/app/api/worker/social/v1/deliveries/claim/route'
import * as heartbeat from '@/app/api/worker/social/v1/deliveries/[id]/heartbeat/route'
import * as submitting from '@/app/api/worker/social/v1/deliveries/[id]/submitting/route'
import * as submitted from '@/app/api/worker/social/v1/deliveries/[id]/submitted/route'
import * as result from '@/app/api/worker/social/v1/deliveries/[id]/result/route'
import * as genClaim from '@/app/api/worker/social/v1/generation/claim/route'
import * as drafts from '@/app/api/worker/social/v1/generation/[id]/drafts/route'
import * as genFailed from '@/app/api/worker/social/v1/generation/[id]/failed/route'
import * as sync from '@/app/api/worker/social/v1/accounts/sync/route'

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>

const ROUTES: Array<[RegExp, Handler]> = [
  [/^\/deliveries\/claim$/, claim.POST as Handler],
  [/^\/deliveries\/([^/]+)\/heartbeat$/, heartbeat.POST],
  [/^\/deliveries\/([^/]+)\/submitting$/, submitting.POST],
  [/^\/deliveries\/([^/]+)\/submitted$/, submitted.POST],
  [/^\/deliveries\/([^/]+)\/result$/, result.POST],
  [/^\/generation\/claim$/, genClaim.POST as Handler],
  [/^\/generation\/([^/]+)\/drafts$/, drafts.POST],
  [/^\/generation\/([^/]+)\/failed$/, genFailed.POST],
  [/^\/accounts\/sync$/, sync.POST as Handler],
]

export const routeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const path = url.pathname.replace(/^\/api\/worker\/social\/v1/, '')
  for (const [re, handler] of ROUTES) {
    const m = re.exec(path)
    if (m) return handler(new Request(url, init), { params: Promise.resolve({ id: m[1] ?? '' }) })
  }
  return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: path } }), { status: 404 })
}) as typeof fetch
