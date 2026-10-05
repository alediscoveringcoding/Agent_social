# Handoff: finishing amendment 03 (W1–W4)

| | |
| --- | --- |
| Date | 2026-10-05 |
| For | The next coding agent (Codex), one task per workstream, then one integration task |
| Spec | [Amendment 03](amendment-03-finish-the-site.md) (read it first), [PRD](PRD.md), [worker API contract](contracts/worker-api.openapi.yaml) |
| Goal | Finish the whole site locally (everything except external services: VPS, Supabase project, Postiz connections, real posts), merge W1–W4 into `main`, pass the end-to-end check in amendment 03 §5. |

Four workstreams were started by Claude agents and stopped part way. Each branch is pushed and clean. Start each task with `git log --oneline main..origin/<branch>` to see what is there.

| WS | Branch | Last commit | State |
| --- | --- | --- | --- |
| W1 | `feat/w1-approval` | `7287835` | Library done (actions, queries, slots, checks). No pages, no tests, CI not run. |
| W2 | `feat/w2-media-cards` | `e900d72` | Card renderer done and tested (54 renders). Storage, upload, signed URLs, actions, UI, tests not started. |
| W3 | `feat/w3-accounts-overview` | `2acf7d2` | Migration 0005 and all libraries done, one test file never run. No pages, no nav, CI not run. |
| W4 | `feat/w4-worker` | `5a11471` | Worker config fixes only (dry-run bug fixed, 8/8 tests). Everything else not started. |

## 1. Rules for every task

- **npm and node only in Linux/WSL, never on Windows.** The checkout is shared between Windows and WSL; npm on Windows installs Windows binaries and breaks the app in WSL. In WSL the repo is `/mnt/r/Repos/Agent_social`. Node 22.6 or newer (22.13+ silences engine warnings).
- **The repo is public.** Never commit secrets, `.env*` files (only `.env.example`), real social handles or a person's legal name. Never commit `another-social-media-report.md` or `deep-research-report.md` (untracked files in the root).
- **Next.js 16.** Read `site/AGENTS.md` and the guide in `site/node_modules/next/dist/docs` before using a Next API. `proxy.ts` replaces middleware; `params` and `searchParams` are Promises.
- **Local mode.** Everything must work with `DB_MODE=local`: PGlite in `site/.local-db/`, code in `site/src/lib/local/`, local login with TOTP. It is temporary but it is what runs today.
- **The fake Supabase client** (`site/src/lib/testing/fake-supabase.ts`) serves both tests and local mode. Queries must stay in its subset: `eq neq in is gt gte lt lte order limit` and embeds. No `.or()`.
- **No real AI calls**, in tests or by hand. The Gemini free tier is 20 requests a day per model and failed requests count. Inject clients or `fetch`.
- **Shared files** (`constants.ts`, `schemas.ts`, `fake-supabase.ts`, `admin-client.ts`, `delivery-payload.ts`, `draft-edit.ts`, `actions.ts`, `DraftEditor.tsx`, `test/hooks.mjs`): small additive edits marked `// W1:` … `// W4:`. `site/src/app/admin/AdminNav.tsx` belongs to W3. New server actions and queries go in new files.
- **Migrations are reserved:** W1 `0003_*`, W2 `0004_*`, W3 `0005_*` (exists), W4 `0006_*`. Add only your own.
- **Known breakage:** `site/src/lib/local/__tests__/local-mode.test.ts` asserts that exactly `0001` and `0002` are applied, so any new migration fails it. Change the assertion to compare against the files in `site/supabase/migrations` (the first workstream to add a migration does it; W3's branch already has 0005).
- **Tests:** `node:test` with PGlite. Follow `site/src/lib/social/__tests__/drafting.test.ts`: `setTestAdminClient(createFakeSupabase(db))`, `setTestAdmin`, `routeFetch`, `WorkerApi`, `runFakeWorkerOnce`. `node:test` only strips types, so it cannot load `.tsx`: keep tested logic in `.ts`.
- **UI text** is Romanian without diacritics, styled like the existing pages (`@/components/ui` is one file; client components call actions in `useTransition`, show errors with `toast` from `sonner`, then `router.refresh()`; pages use `requireAdminPage(path)`).
- **Checks:** `cd site && npm run ci` (typecheck, lint, tests, build) and `cd worker && npx tsc --noEmit && npm test`. `scripts/update.sh --no-pull` from the root runs all of it.
- **Git:** commit small, push the workstream branch often. Never push to `main` except in the integration task, never force-push. The root checkout has an uncommitted, staged change to `scripts/update.sh` by the owner: leave it alone.
- `npm audit` reports 5 high advisories in `eslint-config-next` (lint only, no fix exists). Do not run `npm audit fix --force`; it downgrades Next's lint config and breaks lint.

### Worktrees left by the Claude agents

The four branches are checked out in locked worktrees under `.claude/worktrees/agent-*`, created by Windows git (WSL git cannot read their `.git` link). To work on a branch from WSL, free it first. For each, check it is clean and pushed, then from Windows git:

```
git worktree unlock .claude/worktrees/<dir>
git worktree remove .claude/worktrees/<dir>
```

| Dir | Branch |
| --- | --- |
| `agent-a81d113107c4f8897` | `feat/w1-approval` |
| `agent-a1e923aaab17b7518` | `feat/w2-media-cards` |
| `agent-a5ed75e8807423864` | `feat/w3-accounts-overview` |
| `agent-aec21694ce38a3cbb` | `feat/w4-worker` |

Then use your own clone or a WSL `git worktree add` per branch. In a fresh worktree run `npm ci` in the root and in `site/` (root `npm ci` runs `prepare`, which sets `core.hooksPath`; if git cannot read the worktree, use `--ignore-scripts`).

## 2. W1: approval and scheduling (`feat/w1-approval`)

**Done** (`site/src/lib/social/`):
- `slots.ts` (pure): `DEFAULT_SLOTS` 09:00/13:00/18:00, `parseSlots`, `suggestSlots(accounts, booked, opts)`: next free Bucharest slot per account under its cap, at least 15 min ahead and 60 min from anything booked, 60-day horizon, DST-correct.
- `approval.ts`: `localToInstant`, `checkDestinations` (every PRD 8.2 hard check against the stored rows), `capViolations` / `capMessage` / `daysOf`, `buildApproval` (destination and approval hashes).
- `approval-queries.ts`: `loadPost`, `loadRevisionDestinations`, `loadRevisionCopy`, `hasActiveApproval`, `jobsForDestinations`, `bookedJobs`, `listPosts(filter)`, `getPost(id)` (destinations with job, older revisions' jobs, approval history, activity), `POST_FILTERS`, `CAP_COUNTED_STATUSES`, `SENT_STATUSES`, `CANCELLABLE_STATUSES`.
- `approval-actions.ts` (server actions, `requireAdmin()` first, activity log): `approvePost({postId, revisionId, times, figuresChecked})` (hard checks, figures gate, cap pre-check, saves a "schedule" revision if times changed, then `social_approve_revision`: approval and jobs in one transaction), `reschedulePost`, `reopenForEdit`, `suggestTimes`, `cancelDestination`, `cancelPost`, `retryFailed({confirmReconcileMiss})`. Returns `{ok:false, error, issues}` on failure.
- `draft-edit.ts`, `actions.ts` (`// W1:`): `scheduled_at` is carried into new revisions.

**Left:**
1. `site/src/app/admin/social/postari/page.tsx`: list from `listPosts`, tabs from `?stare=`, per-destination status chips with the public URL.
2. `postari/[id]/page.tsx` and client components. Draft: date and time per destination, slots field and "Sugereaza ore", checkbox "Am verificat cifrele", "Salveaza orele", "Aproba si programeaza". Approved: jobs table with "Anuleaza" per destination, "Anuleaza postarea", "Reincearca doar esuatele" (with the RECONCILE_MISS confirmation), "Reprogrameaza", "Editeaza" (reopen, then go to the editor). Refresh after every approve attempt: approve may have saved a revision before failing.
3. A link from the draft page to the post page, in `ciorne/[id]/page.tsx` (title actions), not in `DraftEditor.tsx`.
4. Tests in `site/src/lib/social/__tests__/`:
   - PRD 14 check 1: with no admin every W1 action is refused and nothing is written; a static check that no route under `src/app/api` imports the approve, save, cancel or retry actions.
   - Check 2: reschedule and reopen after approval revoke the approval and cancel unsubmitted jobs; a direct update on the frozen revision is rejected.
   - Check 3: an unverified figure blocks approval; confirming it via `saveDraft` unblocks.
   - Check 4: a 6th post on the same Bucharest day is refused, also on the October DST day. Compute the next last Sunday of October at run time (past times are refused); 03:30 that day resolves to the first occurrence.
   - Unit tests for `slots.ts`.
   - End to end: draft → `approvePost` → `runFakeWorkerOnce(api, {scenario:'ok'})` → set `next_check_at` to now → run again → published, and `remote_url` shows in `getPost` and `listPosts`.
5. `npm run ci` green.

**Done when:** PRD 14 checks 1–4 pass as tests, a draft goes from the editor to approved jobs and the fake worker publishes them, CI green.

## 3. W2: media and cards (`feat/w2-media-cards`)

**Done:** `site/src/lib/social/cards/`: `palette.ts` (PRD 8.3 tokens, Light/Dark/Mint, 3 brands), `spec.ts` (PRD 10.5 limits, `normalizeCardSpec`, `checkCardSpec`, `keywordRange`, `defaultCardAlt`), `fonts.ts` (Plus Jakarta Sans from `@fontsource`), `layout.ts` (built with `createElement`, since tests cannot load JSX; `cardText` drops glyphs the fonts lack so nothing is fetched), `render.ts` (`renderCardPng(spec, format, brand)` with `next/og` → `{bytes, mime, width, height, format}`). `__tests__/cards.test.ts` renders all 6×3×3. `test/hooks.mjs` maps `next/og` to `next/og.js` (`// W2:`).

**Facts checked in the code:**
- `createLocalAdminClient().storage` is the in-memory `FakeBucket`. `FakeBucket` has private fields, so replace storage by wrapping: `{...fake, storage: {from: (b) => new LocalBucket(...)}} as unknown as FakeSupabase`.
- `proxy.ts` only gates `/admin`, so `/api/media/*` is reachable without a session; the signature is the only gate. The CSP is `img-src 'self'`, so media URLs given to the browser must be relative.
- `buildDraftRevision` copies `card_spec` from the base revision; a card edit overrides `rows.revision.card_spec` afterwards.
- The destination hash (`destinationHash` in `hash.ts`) covers `media: [{sha256, alt_text}]`.
- `social_media` is immutable except `alt_text` (trigger); `social_destination_media` is frozen once a revision is approved.
- No migration is needed: the tables have every column.

**Left:**
1. `site/src/lib/local/storage.ts`: disk storage under `localDbDir()/storage/<bucket>/<path>`; refuse `..` and backslashes; write to a temp file then rename. Same API as the Storage calls the code uses (upload, download, remove, createSignedUrls). `createSignedUrls(paths, ttl)` maps paths to media ids through `social_media` and returns relative `/api/media/<id>?exp=&sig=`. Plug it into `admin-client.ts` (`// W2:`).
2. `site/src/lib/social/media/signing.ts`: HMAC-SHA256 with key `MEDIA_SIGNING_SECRET` ?? `LOCAL_AUTH_SECRET` ?? `SUPABASE_SERVICE_ROLE_KEY` (32+ chars), a label per use; URL signature over id and exp; refuse expired or more than 1 h + 60 s ahead; constant-time compare. Upload tickets `{path, mime, exp (10 min), userId}`. Add `MEDIA_SIGNING_SECRET` to `site/.env.example`.
3. `site/src/lib/social/media/ingest.ts` (sharp): JPEG, PNG, WebP only, 8 MB max, magic bytes checked, `.rotate()` and re-encode in the same format (drops EXIF and GPS); returns sha256, mime, width, height, bytes.
4. Routes: `src/app/api/media/[id]/route.ts` GET (check signature, load row, serve with its mime and `X-Content-Type-Options: nosniff`; 403 on a bad or expired signature); `src/app/api/media/upload/route.ts` POST (local mode; ticket, size, magic bytes; stores `staging/<uuid>`); `src/app/admin/social/media/card-preview/route.ts` GET (admin only, returns the PNG).
5. `src/lib/social/media-actions.ts` (`'use server'`, `requireAdmin` and `logActivity` in each): `createUploadTicket` (local: upload route with POST; Supabase: `createSignedUploadUrl` with PUT), `finalizeUpload` (alt text required, ticket, ingest, store `uploads/<id>.<ext>`, insert `social_media`, delete staging), `generateCards` (per destination, format from `PLATFORM_CARD_FORMAT`, `generated/<id>.png`, `source='generated'`, `card_spec`, `format`, attach), `setDestinationMedia` (new revision via `buildDraftRevision` with replaced media, then `social_save_revision`; copy the base loading from `saveDraft` rather than changing `actions.ts`), `updateMediaAlt`, `deleteMedia` (only when unattached).
6. `delivery-payload.ts`: `buildDeliveryJobs(admin, claimed, opts?: {origin})` turns relative URLs absolute (origin, else `SITE_BASE_URL`); the claim route passes `new URL(request.url).origin`. Absolute Supabase URLs stay as they are (`worker-api.test.ts` expects `http://storage.test/...`).
7. UI: `/admin/social/media/page.tsx` (upload with required alt text, list, edit alt, delete unattached). In `ciorne/[id]/`: `MediaPanel.tsx`, `CardStudio.tsx` (headline, keyword, stat, subline, template, live preview), `DestinationPreview.tsx`, inserted into `DraftEditor.tsx` with a minimal edit replacing the card placeholder in the aside. Attaching is disabled while the editor has unsaved text, otherwise the next save fails with `SOCIAL_STALE_REVISION`.
8. Tests: EXIF/GPS stripped (make a JPEG with sharp `withExif`, run the upload flow); attaching media changes the destination hash, and so does changing only alt text; a signed URL works, an expired or tampered one gets 403; claim payload media URLs download in local mode (set `DB_MODE=local` and a temp `LOCAL_DB_DIR` in that test file; each test file runs in its own process).
9. Optional: the fake worker downloads media and checks sha256, behind an option.

**Done when:** every combination renders (done), upload strips EXIF, attached media changes the destination hash, the worker can download media by URL in local mode, CI green.

## 4. W3: accounts, overview, calendar, manual handoff (`feat/w3-accounts-overview`)

**Done** (paths under `site/`):
- `supabase/migrations/0005_accounts_overview.sql`, with the same revoke/grant block as 0001:
  - `social_admin_update_account(p_account, p_patch jsonb, p_actor, p_now)` locks the row and enforces: auto mode needs a Postiz channel, Substack and Product Hunt stay manual; status must fit the mode (a mode change without status sets `connected` or `manual`); auto → manual refused while queued or claimed jobs exist; brand change refused while open jobs exist; no brand forces paused, unpausing needs a brand; cap 1–5 and not below what is already scheduled on a coming Bucharest day; a synced account's name and profile are read-only. Returns `{changed, before, after}`.
  - `social_admin_create_account(p_fields, p_actor)` (manual-only account), `social_admin_delete_account(p_account, p_actor)` (unused manual account only), `social_mark_events_seen(p_actor, p_ids jsonb, p_up_to bigint)`.
- `src/lib/social/`: `accounts.ts` (pure rules, freshness), `accounts-queries.ts`, `accounts-actions.ts` (`updateAccount`, `createManualAccount`, `deleteManualAccount`), `jobs-view.ts` (jobs with destination, account, post; embed hint `social_posts!social_post_revisions_post_id_fkey`), `overview-queries.ts` (runs `social_sweep`, then approval queue via `listDrafts`, today, next 7 days, failures, manual handoffs due, accounts needing attention, worker health, events), `overview-actions.ts` (`markEventsSeen`), `calendar.ts` (pure, DST-safe week helpers), `calendar-queries.ts`, `handoff.ts` (pure: escaped markdown → HTML and plain text, fields and checklist per platform, download names), `handoff-queries.ts` (`getManualJob`, `listManualJobs`), `handoff-actions.ts` (`markManualPublished`, `duplicatePost`), `server/run-admin-action.ts` (guard with `requireAdmin()` first, `callRpc`, SQL error codes → Romanian messages).
- `__tests__/accounts-admin.test.ts` (never run yet): refusal without admin, every status and mode, cap, open-job guards, manual accounts, worker health.

**Left:**
1. Run `npm run ci` and fix what the first run shows (the code was never type-checked as a whole).
2. Pages: `app/admin/social/page.tsx` (replace the stub with the overview and an event feed with "mark as seen"), `conturi/page.tsx` (table with edit controls, new manual account form), `calendar/page.tsx` (week view, `?week=YYYY-MM-DD`, Bucharest time, status and public URL), `manual/page.tsx` and `manual/[id]/page.tsx` (copy plain / markdown / HTML, downloads txt / md / html, image links, "Open editor", checklist, mark published with URL), a "Duplica" button in `ciorne/[id]/page.tsx` title actions.
3. `app/admin/AdminNav.tsx`: Prezentare, Genereaza, Ciorne, Postari, Calendar, Media, Conturi (Postari is W1's page, Media is W2's).
4. Tests: manual handoff end to end with the fake worker (sync, `createManualAccount` substack, assign and unpause X, `social_create_post`, approve, `runFakeWorkerOnce` whose claim sweep emits `manual_due`, `getManualJob`, `markManualPublished`, post is `published`); overview and `markEventsSeen`; calendar across DST weeks (week of 2026-10-19 has a 25-hour Sunday, week of 2026-03-23 has 167 hours) and draft entries; duplicate; pure tests for `calendar.ts` and `handoff.ts`.
5. `site/README.md` step 6 still says "assign in Supabase Studio": point it at the accounts screen.
6. Fix the `local-mode.test.ts` migration assertion (see §1).

**Done when:** the manual flow completes end to end with the fake worker, every account state can be managed from the UI without Supabase Studio, CI green.

## 5. W4: worker and generator (`feat/w4-worker`)

**Done:** `worker/src/config.ts`: `WORKER_DRY_RUN` read with `z.stringbool()` ("false", "0", "no", "off" turn it off; unset or blank stays true; a typo is an error), blank intervals keep their defaults, new `GENERATOR_EFFORT` (default `medium`) and `GENERATION_HEARTBEAT_MS` (default 120000), `parseConfig(env)` exported. `worker/src/test-support/env.ts` (import first in tests; fake keys so a developer's `.env` cannot leak in). `worker/src/config.test.ts`. The test glob in `worker/package.json` is quoted so nested tests run.

**Starting point:** `services/claude-api.ts` uses non-streaming `messages.create`, `max_tokens` 8192, no output format. `services/gemini-api.ts` has no response schema. `generator/validators.ts` still emits `contains_figures` and its bare-domain regex is wrong for URLs without a path. `worker/.env.example` lacks the two new settings.

**Left:**
1. Claude structured output in `services/claude-api.ts`: stream and take the final message (non-streaming refuses large `max_tokens`); JSON Schema output format; check `stop_reason` (`end_turn` is fine; `refusal`, `max_tokens` and anything else become errors with codes like `AI_REFUSED`, `AI_TRUNCATED`, `AI_BAD_OUTPUT`; the site only requires UPPER_SNAKE_CASE); injectable client for tests. Check every request field against the installed `@anthropic-ai/sdk` types before using it; leave out what is not there.
2. Gemini: `generationConfig.responseJsonSchema` next to `responseMimeType: "application/json"`. Allowed keywords: `$id $defs $ref $anchor type format title description enum items prefixItems minItems maxItems minimum maximum anyOf oneOf properties additionalProperties required propertyOrdering` (no `maxLength`). A `finishReason` other than STOP is an error. Keep the retry rules (5xx twice at 5 s and 15 s; 429 only when RetryInfo ≤ 30 s).
3. One schema for both in `generator/schema.ts`: every property required, `additionalProperties: false` on every object, limits in descriptions, nullable (`anyOf` with null) only for `article` and `launch` (Claude allows few union types), empty strings elsewhere mapped to null afterwards; `settings` and `card.brand` added by the worker, not the model; lowercase enum values after parsing.
4. Prompts in `generator/prompts.ts` for `article` (dev.to, Hashnode, Substack: title, subtitle, body_markdown, tags ≤ 4, canonical_url) and `launch` (Product Hunt: name, tagline ≤ 60, description ≤ 260, maker_comment); variant text "" for those kinds; fill a missing canonical_url from an article source URL.
5. Figures: port `detectFigures`, `maskUrls`, `unlistedFigures` from `site/src/lib/social/figures.ts`; keep the model's sourced figures, dedupe by normalized value preferring sourced over `unverified`; add `unverified` only for numbers the model did not list; skip single-digit plain numbers.
6. Validators: stop emitting `contains_figures`; X weighted length (port `site/src/lib/social/x-length.ts`); bare domains via the site's approach (`findBareDomains` in `content-rules.ts`). Optional: card limits, Instagram 30 hashtags, Product Hunt and dev.to tag limits.
7. Repair in `generator/repair.ts`: send only failing drafts, merge back by `client_ref`, keep the version with fewer errors.
8. Generation heartbeat, site side: `site/supabase/migrations/0006_generation_heartbeat.sql` with `social_generation_heartbeat(p_request uuid, p_worker_id text, p_now timestamptz DEFAULT now())`: unknown request → not found; not running, other owner or lease expired → `social_lease_lost()`; else `lease_expires_at = p_now + 10 min`, return `{ok, lease_expires_at}`; REVOKE from PUBLIC, anon, authenticated and GRANT to service_role explicitly (0001's grant loop does not cover new functions). Route `generation/[id]/heartbeat/route.ts` copied from the deliveries heartbeat route (`idRoute` with a local `z.object({})`; do not edit `schemas.ts`). OpenAPI: add the path and fix the "generation leases have no heartbeat" line. Tests in a new site test file (do not edit `worker-api.test.ts` or `route-fetch.ts`): the owner extends; `social_sweep(now()+1 min)` leaves it running after a heartbeat; 409 for another worker, an expired lease, a finished request; 404.
9. Heartbeat, worker side: `siteApi.generationHeartbeat`; in `processGenerationRequest` a timer chain during generate, repair and post, delay `min(GENERATION_HEARTBEAT_MS, remaining lease / 3)`; on 409 abort with an AbortSignal and report nothing; clear in `finally`. Mock site: lease owner and expiry with 409 on heartbeat, drafts and failed; `MOCK_SITE_LEASE_MS`, `MOCK_SITE_NO_SEED`; print the real port so `MOCK_SITE_PORT=0` works. Test: a generate-plus-repair run longer than the lease keeps its drafts (mock site as a child process, import worker modules after setting `SITE_BASE_URL`).
10. Add `GENERATOR_EFFORT` and `GENERATION_HEARTBEAT_MS` to `worker/.env.example`.

**Done when:** worker type check and tests green including the new ones, the long generate-plus-repair test passes, site CI green.

## 6. Integration (after W1–W4 are green)

1. Merge into `main` in this order: W4 (worker, 0006, migration test fix), W3 (0005, nav), W1, W2 (touches `DraftEditor.tsx`, `delivery-payload.ts`, the claim route, `admin-client.ts`). Expected conflicts: `ciorne/[id]/page.tsx` (W1 link, W3 duplicate button), `draft-edit.ts` and `actions.ts` (W1 and W2), `local-mode.test.ts`, `README.md`, `test/hooks.mjs`.
2. Wire across workstreams: W3's `signMediaUrls` in `handoff-queries.ts` uses W2's local `/api/media` signer; nav links to `/admin/social/postari` (W1) and `/admin/social/media` (W2); overview events link to `/admin/social/postari/{id}`.
3. Run `scripts/update.sh --no-pull` in WSL until everything passes.
4. Amendment 03 §5 end-to-end check on a fresh local database (`npm run db:reset -- --yes` in `site/`): admin and TOTP (by tests), account sync with the fake worker `--sync` and setup in the accounts screen, fake generator drafts, edit and attach a card, schedule, check figures, approve, fake worker claims, downloads the media URL and reports published, overview and calendar show the URL, a manual Substack handoff ending with "mark published". Then the real worker with `WORKER_DRY_RUN=true` against the local site claims and reports a job without calling Postiz.
5. Docs: amendment 03 status ("Done" with what changed), the PRD header row, `site/README.md`, `docs/setup.md` where steps changed, and this file (mark it done or delete it).
6. Push `main`. Delete the four feature branches after the merge only if the owner agrees.

## 7. Out of scope (needs an external service or a person)

A Supabase project and the switch away from local mode, the VPS, Postiz platform connections and developer apps, the Meta tunnel, real test posts, n8n, email or Telegram notifications, the automation API.
