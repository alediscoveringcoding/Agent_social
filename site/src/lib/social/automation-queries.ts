import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * The runs n8n reported through POST /api/automation/social/v1/runs
 * (`social_automation_runs`), for the Automations view. One row per
 * workflow + event; `created_at` is the first report, `updated_at` the last.
 */

export interface AutomationRun {
  id: string
  workflow: string
  event_id: string
  status: 'ok' | 'error' | 'skipped'
  details: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** The latest runs, most recently reported first. `limit` is 1..200 (default 50). */
export async function listAutomationRuns(limit = 50): Promise<AutomationRun[]> {
  const n = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 200) : 50
  const { data, error } = await createAdminClient()
    .from('social_automation_runs')
    .select('id, workflow, event_id, status, details, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(n)
  if (error) throw new Error(`social_automation_runs: ${error.message}`)
  return (data ?? []) as AutomationRun[]
}
