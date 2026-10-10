import {
  apiError,
  apiOk,
  AutomationRequestBody,
  automationSqlError,
  handleAutomationCall,
  readBody,
} from '@/lib/social/server/automation-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/automation/social/v1/generation-requests
 *   {workflow, event_id, brand, input} -> {request_id, created}
 *
 * Idempotent on workflow + event_id: the same event again answers with the
 * request it made the first time and `created: false`. `input` is the same
 * object the Genereaza form stores (GenerationInputSchema, so a 'news' source
 * and `research` are allowed); the worker picks the request up like any other.
 * Creates a request only: nothing is approved or published from here.
 */
export async function POST(request: Request) {
  return handleAutomationCall(request, async (admin) => {
    const body = await readBody(request, AutomationRequestBody)
    if (!body.ok) return body.response
    const { workflow, event_id, brand, input } = body.data

    const { data, error } = await admin.rpc('social_automation_create_request', {
      p_workflow: workflow,
      p_event_id: event_id,
      p_brand: brand,
      p_input: input,
    })
    if (error) {
      const known = automationSqlError(error.message)
      if (known) return known
      throw new Error(`social_automation_create_request: ${error.message}`)
    }
    const result = data as { request_id?: string; created?: boolean } | null
    if (!result?.request_id) return apiError(500, 'INTERNAL', 'No answer from the database')
    return apiOk({ request_id: result.request_id, created: result.created === true })
  })
}
