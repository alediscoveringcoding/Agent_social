'use server'
import { createAdminClient } from '@/lib/supabase/admin'
import { ActionRefusal, callRpc, isUuid, runAdminAction, type ActionResult } from '../social/server/run-admin-action.ts'
import { accountCredentialContext, loadNativeAccount, nativeContext } from './server.ts'
import { refreshNativeAccount } from './refresh.ts'
import { tiktokCreatorInfo, tiktokProvider } from './providers/tiktok.ts'

export async function getTikTokCreator(accountId: string): Promise<ActionResult<{ name: string; privacy: string[]; maxDuration: number }>> {
  return runAdminAction('nativeCreator', {}, async (actor) => {
    if (!isUuid(accountId)) throw new ActionRefusal('Contul nu exista.')
    const admin = createAdminClient()
    try {
      const account = await loadNativeAccount(admin, accountId)
      if (account.platform !== 'tiktok') throw new Error('NATIVE_PLATFORM_INVALID')
      const ctx = nativeContext(admin)
      const refreshed = await refreshNativeAccount(admin, accountId, `admin:${actor.userId}`, account.credentialVersion, account, tiktokProvider, ctx,
        accountCredentialContext(account.platform, account.remoteId, ''))
      const info = await tiktokCreatorInfo(ctx, refreshed.credentials)
      await callRpc(admin, 'social_native_creator_info', { p_account: accountId, p_actor: actor.userId, p_info: {
        privacyLevelOptions: info.privacy_level_options, commentDisabled: info.comment_disabled, duetDisabled: info.duet_disabled,
        stitchDisabled: info.stitch_disabled, maxVideoDurationSeconds: info.max_video_post_duration_sec,
      } })
      return { ok: true, name: info.creator_nickname, privacy: info.privacy_level_options, maxDuration: info.max_video_post_duration_sec }
    } catch { throw new ActionRefusal('Nu am putut verifica optiunile contului TikTok. Reconecteaza contul sau incearca din nou.') }
  })
}
