'use server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { ActionRefusal, callRpc, runAdminAction, type ActionResult } from '../social/server/run-admin-action.ts'

/**
 * Amendment 10: a job of an old Postiz account that was still waiting for a result. Nothing can
 * look it up any more, so the admin checks the platform and records what they found.
 */
export async function resolveLegacyJob(input: { jobId: string; found: boolean; remoteUrl: string; note: string }): Promise<ActionResult> {
  return runAdminAction('legacyResolve', {
    SOCIAL_LEGACY_NOT_WAITING: 'Rezultatul s-a schimbat. Reincarca pagina.',
    SOCIAL_NATIVE_RESOLUTION_NOTE: 'Explica ce ai verificat pe platforma.', SOCIAL_BAD_URL: 'Introdu linkul HTTPS al postarii.',
  }, async (actor) => {
    const parsed = z.object({ jobId: z.uuid(), found: z.boolean(), remoteUrl: z.string().max(4096), note: z.string().trim().min(5).max(1000) }).safeParse(input)
    if (!parsed.success) throw new ActionRefusal('Alege rezultatul si explica verificarea pe platforma.')
    await callRpc(createAdminClient(), 'social_resolve_legacy_job', { p_job: parsed.data.jobId, p_actor: actor.userId,
      p_found: parsed.data.found, p_remote_url: parsed.data.found ? parsed.data.remoteUrl : null, p_note: parsed.data.note })
    revalidatePath('/admin/social/postari', 'layout'); revalidatePath('/admin/social')
    return { ok: true }
  })
}

export async function resolveNativePublication(input: { jobId: string; found: boolean; remoteUrl: string; note: string }): Promise<ActionResult> {
  return runAdminAction('nativeResolve', {
    SOCIAL_NATIVE_NOT_RECONCILING: 'Rezultatul s-a schimbat. Reincarca pagina.',
    SOCIAL_NATIVE_RESOLUTION_TOO_EARLY: 'Confirmarea absentei este disponibila dupa 30 de minute de la trimitere.',
    SOCIAL_NATIVE_RESOLUTION_NOTE: 'Explica ce ai verificat pe platforma.', SOCIAL_BAD_URL: 'Introdu linkul HTTPS al postarii.',
  }, async (actor) => {
    const parsed = z.object({ jobId: z.uuid(), found: z.boolean(), remoteUrl: z.string().max(4096), note: z.string().trim().min(5).max(1000) }).safeParse(input)
    if (!parsed.success) throw new ActionRefusal('Alege rezultatul si explica verificarea pe platforma.')
    await callRpc(createAdminClient(), 'social_native_resolve', { p_job: parsed.data.jobId, p_actor: actor.userId,
      p_found: parsed.data.found, p_remote_url: parsed.data.found ? parsed.data.remoteUrl : null, p_note: parsed.data.note })
    revalidatePath('/admin/social/postari', 'layout'); revalidatePath('/admin/social')
    return { ok: true }
  })
}
