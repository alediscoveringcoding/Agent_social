import { apiError, apiOk, AutomationEventsQuery, handleAutomationCall } from '@/lib/social/server/automation-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface EventRow {
  id: number | string
  type: string
  created_at: string
  payload: unknown
}

/**
 * GET /api/automation/social/v1/events?after={id}&limit={1..100}
 *   -> {events: [{id, type, created_at, payload}], next_after, latest_id}
 *
 * The event outbox (`social_events`), oldest first, strictly after the cursor.
 * n8n keeps `next_after` and sends it back as `after`; with nothing new
 * `next_after` is the `after` it sent. `latest_id` is the highest event id in
 * the outbox (0 when empty): a stored cursor above it means the database was
 * reset since the last poll. Reading does not mark anything as seen (that is
 * the Overview's own "mark as seen").
 */
export async function GET(request: Request) {
  return handleAutomationCall(request, async (admin) => {
    const params = new URL(request.url).searchParams
    const parsed = AutomationEventsQuery.safeParse({
      after: params.get('after') ?? undefined,
      limit: params.get('limit') ?? undefined,
    })
    if (!parsed.success) {
      return apiError(
        422,
        'INVALID_QUERY',
        'after is an integer from 0, limit an integer from 1 to 100',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
      )
    }
    const { after, limit } = parsed.data

    const { data, error } = await admin
      .from('social_events')
      .select('id, type, created_at, payload')
      .gt('id', after)
      .order('id', { ascending: true })
      .limit(limit)
    if (error) throw new Error(`social_events: ${error.message}`)

    const events = ((data ?? []) as EventRow[]).map((e) => ({
      id: Number(e.id),
      type: e.type,
      created_at: new Date(e.created_at).toISOString(),
      payload: e.payload ?? {},
    }))

    // The highest id in the outbox (0 when empty). A cursor above it means the
    // database was reset since n8n last polled.
    const { data: latest, error: latestError } = await admin
      .from('social_events')
      .select('id')
      .order('id', { ascending: false })
      .limit(1)
    if (latestError) throw new Error(`social_events: ${latestError.message}`)
    const latestId = Number((latest as Array<{ id: number | string }> | null)?.[0]?.id ?? 0)

    return apiOk({ events, next_after: events.length ? events[events.length - 1].id : after, latest_id: latestId })
  })
}
