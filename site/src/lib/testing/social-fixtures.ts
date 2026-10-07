/**
 * Test fixtures on a migrated PGlite: accounts, and posts made due and
 * approved with REAL content hashes (so the worker side can verify them).
 */

import type { PGlite } from '@electric-sql/pglite'
import { approvalHash, destinationHash } from '../social/hash.ts'
import { MANUAL_ONLY_PLATFORMS } from '../social/constants.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>

export async function rows(db: PGlite, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query<Row>(sql, params)).rows
}

/** Empty every social table (triggers off for the cleanup only). */
export async function resetSocial(db: PGlite): Promise<void> {
  await db.exec(`
    set session_replication_role = replica;
    delete from social_events; delete from social_publish_attempts; delete from social_delivery_jobs;
    delete from social_approvals; delete from social_destination_media; delete from social_destinations;
    update social_posts set current_revision_id = null;
    delete from social_post_revisions; delete from social_posts; delete from social_media;
    delete from social_generation_requests; delete from social_accounts; delete from social_workers;
    delete from social_activity_log;
    set session_replication_role = origin;`)
}

export async function brandId(db: PGlite, slug = 'taxes-support'): Promise<string> {
  return (await rows(db, `select id from social_brands where slug = $1`, [slug]))[0].id
}

export async function adminUser(db: PGlite, email = 'admin@example.test'): Promise<string> {
  const existing = await rows(db, `select id from auth.users where email = $1`, [email])
  if (existing.length) return existing[0].id
  return (await rows(db, `insert into auth.users (email) values ($1) returning id`, [email]))[0].id
}

let seq = 0
export async function createAccount(
  db: PGlite,
  brand: string,
  platform = 'x',
  extra: { mode?: 'auto' | 'manual'; status?: string; paused?: boolean; cap?: number } = {}
): Promise<string> {
  seq += 1
  const mode = extra.mode ?? ((MANUAL_ONLY_PLATFORMS as readonly string[]).includes(platform) ? 'manual' : 'auto')
  return (
    await rows(
      db,
      `insert into social_accounts (brand_id, platform, mode, status, postiz_integration_id, display_name, paused, daily_cap)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        brand,
        platform,
        mode,
        extra.status ?? (mode === 'manual' ? 'manual' : 'connected'),
        mode === 'manual' ? null : `fx-${seq}`,
        `Cont ${platform} ${seq}`,
        extra.paused ?? false,
        extra.cap ?? 5,
      ]
    )
  )[0].id
}

/**
 * Give the post's current revision a time on every destination (a new
 * revision, as the composer would) and approve it with real hashes.
 */
export async function scheduleAndApprove(
  db: PGlite,
  post: string,
  user: string,
  at: Date = new Date(Date.now() - 5_000)
): Promise<{ revision: string; jobs: string[] }> {
  at.setMilliseconds(0)
  const [p] = await rows(db, `select current_revision_id from social_posts where id = $1`, [post])
  const dests = await rows(
    db,
    `select d.account_id, d.text, d.settings, d.figures,
            coalesce((select jsonb_agg(jsonb_build_object('media_id', m.media_id, 'position', m.position, 'alt_text', m.alt_text) order by m.position)
                        from social_destination_media m where m.destination_id = d.id), '[]'::jsonb) as media
       from social_destinations d where d.revision_id = $1`,
    [p.current_revision_id]
  )
  const [{ id: revision }] = await rows(
    db,
    `select social_save_revision($1, $2, $3, '{}'::jsonb, $4::jsonb, 'test schedule') as id`,
    [post, p.current_revision_id, user, JSON.stringify(dests.map((d) => ({ ...d, scheduled_at: at.toISOString() })))]
  )
  const saved = await rows(
    db,
    `select d.id, d.account_id, d.platform, d.text, d.settings, d.scheduled_at,
            coalesce((select jsonb_agg(jsonb_build_object('sha256', sm.sha256, 'alt_text', m.alt_text) order by m.position)
                        from social_destination_media m join social_media sm on sm.id = m.media_id
                       where m.destination_id = d.id), '[]'::jsonb) as media
       from social_destinations d where d.revision_id = $1`,
    [revision]
  )
  const hashes = saved.map((d) => ({
    id: d.id as string,
    destination_hash: destinationHash({
      account_id: d.account_id,
      platform: d.platform,
      text: d.text,
      settings: d.settings,
      scheduled_at: d.scheduled_at,
      media: d.media,
    }),
  }))
  await rows(db, `select social_approve_revision($1, $2, $3, 'admin@example.test', $4, true, $5::jsonb, now() - interval '1 minute')`, [
    post,
    revision,
    user,
    approvalHash({ post_id: post, revision_id: revision, destinations: hashes }),
    JSON.stringify(hashes.map((h) => ({ ...h, contains_figures: true }))),
  ])
  const jobs = await rows(
    db,
    `select j.id from social_delivery_jobs j join social_destinations d on d.id = j.destination_id where d.revision_id = $1 order by d.platform`,
    [revision]
  )
  return { revision, jobs: jobs.map((j) => j.id) }
}

/** A one-destination post, scheduled a few seconds ago and approved. */
export async function approvedPost(db: PGlite, brand: string, user: string, account: string, text = 'Salut de la test') {
  const [{ id: post }] = await rows(db, `select social_create_post($1::jsonb, $2::jsonb, $3::jsonb) as id`, [
    JSON.stringify({ brand_id: brand, kind: 'social', title: text.slice(0, 40), created_by: user }),
    JSON.stringify({ canonical_text: text }),
    JSON.stringify([{ account_id: account, text, settings: {}, scheduled_at: null }]),
  ])
  const { revision, jobs } = await scheduleAndApprove(db, post, user)
  return { post, revision, job: jobs[0] }
}
