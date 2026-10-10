'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { callRpc, isUuid, runAdminAction, type ActionResult, type SqlMessages } from './server/run-admin-action.ts'

/**
 * "Verificat" on a source link (amendment 07). requireAdmin() first (inside
 * runAdminAction); the change is one SQL function, which also writes the
 * activity row. Approval stays blocked until every source of the post is
 * ticked, and the ticks freeze with the approval.
 */

const MESSAGES: SqlMessages = {
  SOCIAL_SOURCE_NOT_FOUND: 'Sursa nu mai exista. Reincarca pagina.',
  SOCIAL_SOURCES_FROZEN: 'Postarea e aprobata si sursele ei nu se mai schimba. Editeaz-o ca sa faci o revizie noua.',
}

interface Changed {
  changed: boolean
  post_id: string
}

export async function setSourceVerified(sourceId: string, verified: boolean): Promise<ActionResult> {
  return runAdminAction<object>('setSourceVerified', MESSAGES, async (actor) => {
    if (!isUuid(sourceId) || typeof verified !== 'boolean') return { ok: false, error: MESSAGES.SOCIAL_SOURCE_NOT_FOUND as string }
    const result = await callRpc<Changed>(createAdminClient(), 'social_set_source_verified', {
      p_source: sourceId,
      p_user: actor.userId,
      p_verified: verified,
    })
    revalidatePath('/admin/social/ciorne')
    if (result?.post_id) {
      revalidatePath(`/admin/social/ciorne/${result.post_id}`)
      revalidatePath(`/admin/social/postari/${result.post_id}`)
    }
    return { ok: true }
  })
}
