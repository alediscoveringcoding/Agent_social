'use server'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { ActionRefusal, isUuid, runAdminAction, type ActionResult } from '../social/server/run-admin-action.ts'
import { connectNativeCandidate } from './candidates.ts'

export async function selectNativeDestination(input: { id: string; index: number }): Promise<ActionResult<{ accountId: string }>> {
  return runAdminAction('nativeDestination', { SOCIAL_NATIVE_OAUTH_EXPIRED: 'Conectarea a expirat sau a fost deja folosita. Reia autorizarea.' }, async (actor) => {
    if (!isUuid(input?.id) || !Number.isInteger(input.index) || input.index < 0 || input.index >= 100) throw new ActionRefusal('Alege un cont din lista.')
    const accountId = await connectNativeCandidate(createAdminClient(), actor.userId, input.id, input.index)
    revalidatePath('/admin/social/conturi')
    return { ok: true, accountId }
  })
}
