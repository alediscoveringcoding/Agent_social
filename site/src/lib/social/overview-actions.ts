'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { logActivity } from './server/activity.ts'
import { callRpc, runAdminAction, type ActionResult } from './server/run-admin-action.ts'

/**
 * "Mark as seen" on the Overview's event feed (amendment 01 A10): one event,
 * or every unseen event up to the newest one the page showed.
 */
export async function markEventsSeen(input: { ids?: number[]; upTo?: number }): Promise<ActionResult<{ marked: number }>> {
  return runAdminAction<{ marked: number }>('markEventsSeen', {}, async (actor) => {
    const ids = (input?.ids ?? []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 500)
    const upTo = input?.upTo === undefined ? null : Number(input.upTo)
    if (!ids.length && (upTo === null || !Number.isSafeInteger(upTo) || upTo <= 0)) {
      return { ok: false, error: 'Nimic de marcat.' }
    }
    const db = createAdminClient()
    const marked = await callRpc<number>(db, 'social_mark_events_seen', {
      p_actor: actor.userId,
      p_ids: ids.length ? ids : null,
      p_up_to: ids.length ? null : upTo,
    })
    await logActivity(db, actor, {
      action: 'social.events_seen',
      details: ids.length ? { ids, marked } : { up_to: upTo, marked },
    })
    revalidatePath('/admin/social')
    return { ok: true, marked: Number(marked) || 0 }
  })
}
