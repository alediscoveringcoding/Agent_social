# Amendment 10: Postiz removed, platforms dropped, post length

Status: implemented locally on 2026-10-22. Live platform publishing and real AI calls are not
exercised by the checks. Owner decisions taken on 2026-10-22:

- Finish the move away from Postiz and Docker Compose: the app is the Next.js site plus the
  TypeScript worker, with no Postiz, Docker, Redis or Temporal. n8n stays optional.
- Drop the platforms that never got a direct adapter, and keep a visible record of them.
- Post length is picked per request, **short** or **long**, and is the same on every platform.

## 1. Postiz and Docker Compose are gone

- Deleted: `local/docker-compose.yml` and its Temporal config, the worker's Postiz client, payload
  builder and account sync loop, the site's `/accounts/sync` and `/deliveries/{id}/submitted`
  routes, `sync-rules.ts`, `docs/postiz-notes.md`, and the `POSTIZ_*` and `SYNC_LOOP_INTERVAL_MS`
  settings. Old values left in a `.env` are ignored.
- The worker schedules only. For a publish job it checks the approved hash, calls `/submitting`
  and asks the site to publish (`/deliveries/{id}/native`); for poll and reconcile jobs it asks the
  site to check its journal. A job of an old Postiz account fails with `LEGACY_POSTIZ_ACCOUNT`.
- Migration `0022_remove_postiz.sql`:
  - the claim hands out jobs of native accounts only (and only to `native-v1` workers);
  - automatic mode needs a direct connection (`SOCIAL_AUTO_NEEDS_CONNECTION`);
  - old Postiz accounts that were `connected` become `reconnect_required` (logged as
    `social.postiz_retired`); their name and profile can be edited, and an unused one deleted;
  - `social_resolve_legacy_job` lets an admin close a job of an old Postiz account that was still
    waiting for a result (submitted or reconciling): found with its URL, or confirmed absent. The
    post page offers it next to the native resolution form.
  - No history is rewritten: Postiz ids, jobs, approvals and hash vectors stay as they were.
- Local testing without platforms: `npm run db:test-accounts` (site stopped) adds one paused test
  account per kept platform. A native test account holds a placeholder credential, so a real
  publication would fail before any request. The fake worker reports results like the real
  worker in dry run.
- The helper scripts are TypeScript run by Node's type stripping: `scripts/dev-up.ts`,
  `dev-down.ts`, `health-check.ts` and `backup-local.ts` (no Docker, no `--include-postiz`). The
  worker's mock site is `worker/test/mock-site.ts`.

## 2. Dropped platforms

Not implemented, and dropped: Threads, Reddit, Pinterest, Nostr, VK, Google Business, Tumblr,
Dribbble, Whop, Moltbook, Kick and Twitch. Excluded earlier by the owner: WordPress, Discord and
Mastodon. Together they are `DROPPED_PLATFORMS` (site `constants.ts`, worker `platforms.ts`, SQL
`social_dropped_platforms()`).

- No new account (`SOCIAL_PLATFORM_DROPPED`), generation request or generated variant uses them;
  the model's schema and the prompt leave them out, and their playbooks are deleted.
- They stay in `PLATFORMS`, the DB constraints and the validators, so older drafts and accounts
  still load. The accounts screen lists them under "Neimplementate, scoase din aplicatie".

## 3. Post length

`GenerationInput.length`: `short` or `long` (default `long`), chosen in Genereaza and accepted by
the automation API.

| Form | canonical_text and every social variant | Platforms with a lower limit |
| --- | --- | --- |
| short | 250-600 characters (about 40-100 words) | up to the limit, at least 40% of it |
| long | 1,200-2,000 characters (about 200-330 words) | 70% to 100% of the limit (X 196-280, Bluesky 210-300, Farcaster 224-320, Telegram with an image 716-1,024) |

- The writer prompt has a LENGTH section after the playbooks, brand notes, examples and the owner's
  briefs, and it wins over any length they give. The hook rule now says the hook only opens the post.
- The worker checks each text (`too_short`, `too_long_for_form`, 25% over the range) and sends a
  failing draft back once for a rewrite. Requests stored before this amendment have no length
  field: they are written long, without the check.
- Long requests are written 3 drafts per AI call (short: 8), each call told what the earlier ones
  wrote; repairs are batched the same way. If a later call fails, the drafts already written are
  posted with a note. A request for 5 long drafts costs 2 writer calls instead of 1.

## 4. Checks

Verified in WSL on 2026-10-22:

- Site `npm run ci`: type check, lint, all 572 tests and the production build passed.
- Worker `npx --no-install tsc --noEmit && npm test`: type check and all 197 tests passed.
- Helper TypeScript syntax and the existing WSL launcher's help command passed.
- Backup checks used temporary data and fake environment files: data/key-file copying,
  private permissions and refusal to copy an active database passed.
- The running site and worker returned HTTP 200 to the local health checks.

Database tests use temporary PGlite databases and injected clients. No real AI,
social publishing or newsletter delivery was invoked by these checks. The immutable
approval hash fixtures remain unchanged.
