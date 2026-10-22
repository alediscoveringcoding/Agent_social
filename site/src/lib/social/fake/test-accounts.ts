/**
 * Test accounts for localhost (amendment 10; they replace the fake Postiz channels the old
 * `--sync` registered). One account per active platform, paused and without a brand, so the
 * admin screens and the fake worker have something to work with before any real connection.
 *
 * Platforms with a direct connector get a native automatic account whose stored credential
 * is a placeholder: a real publication would fail to decrypt it and send nothing. The other
 * platforms get a manual account. Running it again adds only what is missing.
 */

import { ACTIVE_PLATFORMS, PLATFORM_LABELS, type ActivePlatform } from '../constants.ts'
import { AUTOMATIC_API_PLATFORMS } from '../../native/capabilities.ts'

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

export const TEST_ACCOUNT_ID_PREFIX = 'test-account-'
/** At least 40 characters (social_native_credentials.encrypted) and never valid ciphertext. */
const PLACEHOLDER_CREDENTIAL = 'test-account-placeholder-no-real-credential-stored'

export const testAccountName = (platform: ActivePlatform) => `${PLATFORM_LABELS[platform]} (test)`

export async function insertTestAccounts(query: Query): Promise<{ created: string[]; existing: string[] }> {
  const created: string[] = []
  const existing: string[] = []
  for (const platform of ACTIVE_PLATFORMS) {
    const name = testAccountName(platform)
    const found = await query(`select 1 from social_accounts where platform = $1 and display_name = $2`, [platform, name])
    if (found.rows.length) {
      existing.push(platform)
      continue
    }
    const native = (AUTOMATIC_API_PLATFORMS as readonly string[]).includes(platform)
    const { rows } = native
      ? await query(
          `insert into social_accounts (platform, mode, status, publishing_backend, native_provider_account_id, display_name, paused)
           values ($1, 'auto', 'connected', 'native', $2, $3, true) returning id`,
          [platform, `${TEST_ACCOUNT_ID_PREFIX}${platform}`, name]
        )
      : await query(
          `insert into social_accounts (platform, mode, status, display_name, paused)
           values ($1, 'manual', 'manual', $2, true) returning id`,
          [platform, name]
        )
    const id = (rows[0] as { id: string }).id
    if (native) {
      await query(`insert into social_native_credentials (account_id, encrypted, metadata) values ($1, $2, '{"test": true}'::jsonb)`, [id, PLACEHOLDER_CREDENTIAL])
    }
    await query(`select public.social_log_system('social.test_account_created', null, null, $1, $2::jsonb)`, [id, JSON.stringify({ platform, native })])
    created.push(platform)
  }
  return { created, existing }
}
