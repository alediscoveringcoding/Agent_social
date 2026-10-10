'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { ACCOUNT_PATCH_KEYS, STATUSES_FOR_MODE, isManualOnlyPlatform, type AccountPatch } from './accounts.ts'
import { ACCOUNT_STATUSES, DEFAULT_OPEN_EDITOR_URLS, PLATFORM_LABELS, isPlatform, type Platform } from './constants.ts'
import { formatBucharest } from './time.ts'
import { logActivity } from './server/activity.ts'
import {
  ActionRefusal,
  callRpc,
  isUuid,
  runAdminAction,
  type ActionResult,
  type SqlMessages,
} from './server/run-admin-action.ts'

/**
 * Server actions of the accounts screen (/admin/social/conturi, PRD F1).
 * Each one: requireAdmin() first, the change through a SQL function of 0005
 * (one transaction, row lock), then a row in social_activity_log. Every field
 * an account has can be changed here, so nobody needs Supabase Studio.
 */

const MESSAGES: SqlMessages = {
  SOCIAL_ACCOUNT_NOT_FOUND: 'Contul nu mai exista. Reincarca pagina.',
  SOCIAL_BRAND_NOT_FOUND: 'Alege un brand din lista.',
  SOCIAL_BAD_MODE: 'Modul e automat sau manual.',
  SOCIAL_BAD_STATUS: 'Alege o stare din lista.',
  SOCIAL_CAP_RANGE: 'Limita zilnica e intre 1 si 5 postari.',
  SOCIAL_BAD_URL: 'Linkul trebuie sa inceapa cu https://.',
  SOCIAL_NAME_REQUIRED: 'Numele contului e obligatoriu (cel mult 120 de caractere).',
  SOCIAL_ACCOUNT_NO_BRAND: 'Alege intai brandul; un cont fara brand ramane pe pauza.',
  SOCIAL_SYNCED_FIELD: 'Numele si profilul unui cont din Postiz vin de la sincronizare.',
  SOCIAL_AUTO_NEEDS_POSTIZ: 'Publicarea automata are nevoie de un canal Postiz. Contul acesta poate fi doar manual.',
  SOCIAL_MANUAL_ONLY_PLATFORM: 'Substack, Product Hunt, YouTube, Quora, LinkedIn (articol), TradingView, Investing.com, Indie Hackers, Stack Exchange, GitHub, Forum si Presa nu se publica automat: raman manuale.',
  SOCIAL_STATUS_FOR_MODE: 'Starea nu se potriveste cu modul. Un cont manual e "Manual" sau "Asteapta aprobarea platformei".',
  SOCIAL_ACCOUNT_HAS_OPEN_JOBS: (d) =>
    `Contul are ${Number(d?.jobs ?? 0) || 'cateva'} postari programate care nu au plecat. Anuleaza-le sau asteapta sa plece, apoi reincearca.`,
  SOCIAL_CAP_BELOW_SCHEDULED: (d) =>
    `Pe ${d?.day ? formatDay(String(d.day)) : 'o zi viitoare'} sunt deja ${d?.used ?? 'mai multe'} postari programate. Limita nu poate cobori sub atat.`,
  SOCIAL_ACCOUNT_SYNCED: 'Un cont din Postiz nu se sterge de aici: ar reaparea la urmatoarea sincronizare. Pune-l pe pauza.',
  SOCIAL_ACCOUNT_IN_USE: 'Contul e folosit de postari, asa ca ramane in istoric. Pune-l pe pauza in loc sa il stergi.',
  SOCIAL_BAD_PLATFORM: 'Alege o platforma din lista.',
}

function formatDay(day: string): string {
  return formatBucharest(`${day}T12:00:00Z`).split(',')[0]
}

function revalidateAccounts() {
  revalidatePath('/admin/social')
  revalidatePath('/admin/social/conturi')
}

const HTTPS = /^https:\/\/[^\s]+$/i

function cleanUrl(v: unknown, what: string): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (!s) return null
  if (!HTTPS.test(s) || s.length > 2048) throw new ActionRefusal(`${what} trebuie sa inceapa cu https://.`)
  return s
}

/** Keep only known fields with the right types; the SQL function checks the rest. */
function cleanPatch(patch: AccountPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ACCOUNT_PATCH_KEYS) {
    if (!(key in (patch ?? {}))) continue
    const v = patch[key]
    switch (key) {
      case 'brand_id':
        if (v !== null && v !== '' && !isUuid(v)) throw new ActionRefusal('Alege un brand din lista.')
        out.brand_id = v || null
        break
      case 'mode':
        if (v !== 'auto' && v !== 'manual') throw new ActionRefusal(MESSAGES.SOCIAL_BAD_MODE as string)
        out.mode = v
        break
      case 'status':
        if (!(ACCOUNT_STATUSES as readonly unknown[]).includes(v)) throw new ActionRefusal(MESSAGES.SOCIAL_BAD_STATUS as string)
        out.status = v
        break
      case 'daily_cap': {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 1 || n > 5) throw new ActionRefusal(MESSAGES.SOCIAL_CAP_RANGE as string)
        out.daily_cap = n
        break
      }
      case 'paused':
        out.paused = v === true
        break
      case 'open_editor_url':
        out.open_editor_url = cleanUrl(v, 'Linkul editorului')
        break
      case 'profile_url':
        out.profile_url = cleanUrl(v, 'Linkul profilului')
        break
      case 'display_name':
        out.display_name = String(v ?? '').trim().slice(0, 200)
        break
    }
  }
  return out
}

export async function updateAccount(
  accountId: string,
  patch: AccountPatch
): Promise<ActionResult<{ changed: string[] }>> {
  return runAdminAction<{ changed: string[] }>('updateAccount', MESSAGES, async (actor) => {
    if (!isUuid(accountId)) return { ok: false, error: MESSAGES.SOCIAL_ACCOUNT_NOT_FOUND as string }
    const clean = cleanPatch(patch)
    if (clean.mode && clean.status && !STATUSES_FOR_MODE[clean.mode as 'auto' | 'manual'].includes(clean.status as never)) {
      return { ok: false, error: MESSAGES.SOCIAL_STATUS_FOR_MODE as string }
    }
    const db = createAdminClient()
    const result = await callRpc<{ changed: string[]; before: Record<string, unknown>; after: Record<string, unknown> }>(
      db,
      'social_admin_update_account',
      { p_account: accountId, p_patch: clean, p_actor: actor.userId }
    )
    const changed = result?.changed ?? []
    if (changed.length) {
      await logActivity(db, actor, {
        action: 'social.account_updated',
        accountId,
        details: { changed, before: result.before, after: result.after },
      })
      revalidateAccounts()
    }
    return { ok: true, changed }
  })
}

export interface ManualAccountForm {
  platform: Platform
  brandId: string
  displayName: string
  openEditorUrl?: string | null
  profileUrl?: string | null
  dailyCap?: number
}

export async function createManualAccount(form: ManualAccountForm): Promise<ActionResult<{ accountId: string }>> {
  return runAdminAction<{ accountId: string }>('createManualAccount', MESSAGES, async (actor) => {
    if (!isPlatform(form?.platform)) return { ok: false, error: MESSAGES.SOCIAL_BAD_PLATFORM as string }
    if (!isUuid(form.brandId)) return { ok: false, error: MESSAGES.SOCIAL_BRAND_NOT_FOUND as string }
    const name = String(form.displayName ?? '').trim()
    if (!name) return { ok: false, error: MESSAGES.SOCIAL_NAME_REQUIRED as string }
    const cap = form.dailyCap === undefined ? 5 : Number(form.dailyCap)
    if (!Number.isInteger(cap) || cap < 1 || cap > 5) return { ok: false, error: MESSAGES.SOCIAL_CAP_RANGE as string }
    const editor = cleanUrl(form.openEditorUrl, 'Linkul editorului') ?? DEFAULT_OPEN_EDITOR_URLS[form.platform] ?? null
    const profile = cleanUrl(form.profileUrl, 'Linkul profilului')

    const db = createAdminClient()
    const accountId = await callRpc<string>(db, 'social_admin_create_account', {
      p_fields: {
        platform: form.platform,
        brand_id: form.brandId,
        display_name: name.slice(0, 120),
        open_editor_url: editor,
        profile_url: profile,
        daily_cap: cap,
      },
      p_actor: actor.userId,
    })
    await logActivity(db, actor, {
      action: 'social.account_created',
      accountId,
      details: { platform: form.platform, brand_id: form.brandId, display_name: name, manual_only: isManualOnlyPlatform(form.platform) },
    })
    revalidateAccounts()
    return { ok: true, accountId }
  })
}

export async function deleteManualAccount(accountId: string): Promise<ActionResult> {
  return runAdminAction('deleteManualAccount', MESSAGES, async (actor) => {
    if (!isUuid(accountId)) return { ok: false, error: MESSAGES.SOCIAL_ACCOUNT_NOT_FOUND as string }
    const db = createAdminClient()
    const gone = await callRpc<{ platform: Platform; display_name: string; brand_id: string | null }>(
      db,
      'social_admin_delete_account',
      { p_account: accountId, p_actor: actor.userId }
    )
    await logActivity(db, actor, {
      action: 'social.account_deleted',
      accountId,
      details: { ...gone, platform_label: gone?.platform ? PLATFORM_LABELS[gone.platform] : null },
    })
    revalidateAccounts()
    return { ok: true }
  })
}
