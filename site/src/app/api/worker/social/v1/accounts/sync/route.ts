import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccountStatus } from '@/lib/social/constants'
import { SyncBody } from '@/lib/social/schemas'
import { becameReconnectRequired, platformForProvider, syncedStatus } from '@/lib/social/sync-rules'
import { apiOk, handleWorkerCall, readBody } from '@/lib/social/server/worker-http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ExistingAccount {
  id: string
  platform: string
  status: AccountStatus
  postiz_integration_id: string
}

function httpUrlOrNull(value: string | null | undefined): string | null {
  return value && /^https?:\/\//i.test(value) ? value.slice(0, 2048) : null
}

async function emit(admin: SupabaseClient, type: string, payload: Record<string, unknown>) {
  const { error } = await admin.from('social_events').insert({ type, payload })
  if (error) console.error('[social/sync] could not write %s event:', type, error.message)
}

/**
 * POST /api/worker/social/v1/accounts/sync
 *   {integrations: [...], postiz_recent_posts: [...]} -> {upserted, ignored, foreign_posts}
 *
 * Upserts by Postiz integration id. Read-then-write rather than an upsert, so
 * the status rules can see the previous status (sync-rules.ts). A channel new
 * to the site arrives PAUSED and with no brand: it publishes nothing until a
 * person assigns it and unpauses it (one account at a time, PRD M4/M5).
 */
export async function POST(request: Request) {
  return handleWorkerCall(request, async ({ workerId, admin }) => {
    const body = await readBody(request, SyncBody)
    if (!body.ok) return body.response
    const now = new Date().toISOString()

    const ids = body.data.integrations.map((i) => i.postiz_integration_id)
    const { data: rows, error } = await admin
      .from('social_accounts')
      .select('id, platform, status, postiz_integration_id')
      .in('postiz_integration_id', ids.length ? ids : ['-'])
    if (error) throw new Error(`accounts: ${error.message}`)
    const existing = new Map(((rows ?? []) as ExistingAccount[]).map((r) => [r.postiz_integration_id, r]))

    let upserted = 0
    const ignored: Array<{ postiz_integration_id: string; reason: string }> = []

    for (const integration of body.data.integrations) {
      const platform = platformForProvider(integration.provider)
      if (!platform) {
        ignored.push({ postiz_integration_id: integration.postiz_integration_id, reason: `unknown provider ${integration.provider}` })
        continue
      }
      const before = existing.get(integration.postiz_integration_id) ?? null
      if (before && before.platform !== platform) {
        ignored.push({ postiz_integration_id: integration.postiz_integration_id, reason: 'provider changed platform' })
        continue
      }
      const status = syncedStatus(before?.status ?? null, integration.refresh_needed === true)
      const fields = {
        postiz_provider: integration.provider,
        postiz_disabled: integration.disabled === true,
        display_name: integration.name || integration.postiz_integration_id,
        picture_url: httpUrlOrNull(integration.picture_url),
        profile_url: httpUrlOrNull(integration.profile_url),
        rules: integration.rules ?? {},
        last_synced_at: now,
        status,
        updated_at: now,
      }

      if (before) {
        const { error: upError } = await admin.from('social_accounts').update(fields).eq('id', before.id)
        if (upError) throw new Error(`update account: ${upError.message}`)
      } else {
        const { error: insError } = await admin.from('social_accounts').insert({
          ...fields,
          platform,
          mode: 'auto',
          brand_id: null,
          paused: true,
          postiz_integration_id: integration.postiz_integration_id,
        })
        // 23505: another sync inserted it a moment ago; the next sync updates it.
        if (insError && insError.code !== '23505') throw new Error(`insert account: ${insError.message}`)
      }
      upserted += 1

      if (becameReconnectRequired(before?.status ?? null, status)) {
        await emit(admin, 'account_reconnect_required', {
          postiz_integration_id: integration.postiz_integration_id,
          account_id: before?.id ?? null,
          platform,
          name: fields.display_name,
          reason: 'refresh_needed',
        })
      }
    }

    // Foreign posts (PRD F7): a Postiz post no job of ours created. A post
    // between /submitting and /submitted is ours but not yet recorded, so an
    // account with a job in flight is skipped this round.
    let foreign = 0
    const recent = body.data.postiz_recent_posts ?? []
    if (recent.length) {
      const postIds = recent.map((p) => p.postiz_post_id)
      const [{ data: known }, { data: seen }, { data: inflight }] = await Promise.all([
        admin.from('social_delivery_jobs').select('postiz_post_id').in('postiz_post_id', postIds),
        admin.from('social_events').select('payload').eq('type', 'foreign_post').in('payload->>postiz_post_id', postIds),
        admin
          .from('social_delivery_jobs')
          .select('account:social_accounts(postiz_integration_id)')
          .in('status', ['submitting', 'reconciling']),
      ])
      const knownIds = new Set(((known ?? []) as Array<{ postiz_post_id: string }>).map((k) => k.postiz_post_id))
      const seenIds = new Set(
        ((seen ?? []) as Array<{ payload: { postiz_post_id?: string } }>).map((s) => s.payload?.postiz_post_id)
      )
      const busy = new Set(
        ((inflight ?? []) as unknown as Array<{ account: { postiz_integration_id: string | null } | null }>)
          .map((r) => r.account?.postiz_integration_id)
          .filter(Boolean)
      )
      for (const p of recent) {
        if (knownIds.has(p.postiz_post_id) || seenIds.has(p.postiz_post_id) || busy.has(p.integration_id)) continue
        await emit(admin, 'foreign_post', {
          postiz_post_id: p.postiz_post_id,
          integration_id: p.integration_id,
          created_at: p.created_at ?? null,
        })
        foreign += 1
      }
    }

    const { error: wError } = await admin
      .from('social_workers')
      .update({ last_account_sync_at: now })
      .eq('worker_id', workerId)
    if (wError) console.error('[social/sync] could not record the sync time:', wError.message)

    return apiOk({ upserted, ignored, foreign_posts: foreign })
  })
}
