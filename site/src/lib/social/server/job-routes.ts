import 'server-only'
import type { z } from 'zod'
import { apiError, handleWorkerCall, isUuid, readBody, type WorkerContext } from './worker-http.ts'

/**
 * The shape shared by the `/deliveries/{id}/...` and `/generation/{id}/...`
 * routes: authenticate, check the id, parse the body, run the handler.
 */
export function idRoute<S extends z.ZodType>(
  schema: S,
  handler: (id: string, body: z.infer<S>, ctx: WorkerContext) => Promise<Response>
) {
  return async (request: Request, { params }: { params: Promise<{ id: string }> }) =>
    handleWorkerCall(request, async (ctx) => {
      const { id } = await params
      if (!isUuid(id)) return apiError(404, 'NOT_FOUND', 'Unknown id')
      const body = await readBody(request, schema)
      if (!body.ok) return body.response
      return handler(id.toLowerCase(), body.data, ctx)
    })
}
