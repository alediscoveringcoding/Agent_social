import { z } from 'zod'
import { apiError, fromTransition, handleWorkerCall, isUuid, readBody } from '@/lib/social/server/worker-http'
import { nativeDelivery } from '@/lib/native/server'

export const runtime = 'nodejs'
export const maxDuration = 300
const schema = z.object({ attempt_no: z.number().int().positive(), kind: z.enum(['publish', 'check']) }).strict()

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleWorkerCall(request, async ({ admin, workerId }) => {
    const { id } = await context.params
    if (!isUuid(id)) return apiError(404, 'NOT_FOUND', 'No such job')
    const body = await readBody(request, schema)
    if (!body.ok) return body.response
    return fromTransition({ ...await nativeDelivery(admin, workerId, id, body.data.attempt_no, body.data.kind) })
  })
}
