import { apiOk, AutomationRunBody, automationSqlError, handleAutomationCall, readBody } from '@/lib/social/server/automation-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/automation/social/v1/runs {workflow, event_id, status, details?} -> {ok: true}
 *
 * Logs what a workflow did for one event, for the Automations view. An
 * upsert on workflow + event_id: reporting the same event again replaces its
 * status and details. `status` is ok, error or skipped.
 */
export async function POST(request: Request) {
  return handleAutomationCall(request, async (admin) => {
    const body = await readBody(request, AutomationRunBody)
    if (!body.ok) return body.response
    const { workflow, event_id, status, details } = body.data

    const { error } = await admin.rpc('social_automation_log_run', {
      p_workflow: workflow,
      p_event_id: event_id,
      p_status: status,
      p_details: details ?? {},
    })
    if (error) {
      const known = automationSqlError(error.message)
      if (known) return known
      throw new Error(`social_automation_log_run: ${error.message}`)
    }
    return apiOk({ ok: true })
  })
}
