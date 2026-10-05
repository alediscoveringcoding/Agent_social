# Amendment 03: finishing the site locally

| | |
| --- | --- |
| Status | Done locally; external services remain out of scope |
| Date | 2026-10-05 |
| Completed | 2026-10-06 |
| Amends | [PRD](PRD.md), [Amendment 01](amendment-01-localhost-mvp.md), [Amendment 02](amendment-02-standalone-site.md) |
| Decision | Build everything that does not need an external service or a person's hands, so the whole flow runs on one Linux/WSL machine: generate → edit → cards and media → approve and schedule → worker (dry run) → published state, manual handoff, overview and calendar. |

## 1. Decisions taken since amendment 02

W1–W4 are implemented: approval and scheduling, private media storage and all 54 card combinations, accounts/overview/calendar/manual handoff, and structured generation with lease heartbeats. Approval checks the immutable card actually attached to each destination. Media edits use an atomic draft-state guard; editor mutations block competing edits. Local acceptance covers fake generation and delivery, signed media downloads, manual publication, and the production worker's dry-run delivery path. No real AI or platform calls were used to validate the build.

| Topic | Decision |
| --- | --- |
| Database while there is no Supabase | **Local mode** (`DB_MODE=local`, TEMPORARY): PGlite (Postgres in WASM) in `site/.local-db/`, git-ignored, built from `site/supabase/migrations` on open. The same SQL functions run as on Supabase. One process owns the files. Remove `site/src/lib/local/` and the `isLocalMode()` branches when moving to Supabase. |
| Login while there is no Supabase Auth | Local login with the same shapes as Supabase Auth: scrypt passwords, RFC 6238 TOTP (key typed into the authenticator, no QR), signed httpOnly session cookie with `aal1`/`aal2`. `ADMIN_EMAILS` and aal2-on-every-screen are unchanged. |
| Keeping a checkout current | `scripts/update.sh` (Linux/WSL only): pull, install when needed, create `.env` files with random secrets, migrate the local database, run every check. Run it after each update. npm is never run from Windows. |
| AI providers | Claude and Gemini. The admin picks the model per generation request (`input.ai`); no pick means the worker's `.env` default. A pick without its key fails the request with `AI_NOT_CONFIGURED`. Gemini overload (5xx) is retried twice; a daily-quota 429 is not retried. |
| Notifications (F9, Q6) | In v1 local: the in-app event feed only (overview, A10). Email or Telegram later, with the automation API. |
| Q3 dev.to / Hashnode language | Romanian, canonical URL to our blog. |
| Q4 Product Hunt | Launch kit only, always manual handoff. |
| Q5 Second approver | No. |
| Default slots (F4 "suggest slot") | 09:00, 13:00, 18:00 Europe/Bucharest. |
| Branching | Parallel workstreams on their own branches, merged into `main` by one integrator who runs `scripts/update.sh` and the end-to-end check below. Day-to-day single changes go straight to `main`. |

## 2. Media and cards in local mode

- **Storage.** In local mode, objects live on disk under `site/.local-db/storage/<bucket>/<path>`. The upload flow keeps the PRD shape: the server issues a short-lived signed upload token, and the browser sends the file to the site's own upload route. The route checks type and size (JPEG, PNG or WebP, at most 8 MB), strips metadata with `sharp`, and stores sha256, MIME type, width, height and size. In Supabase mode the same flow uses Storage signed upload URLs.
- **Media URLs for the worker.** `/deliveries/claim` keeps returning signed URLs. In local mode these point to a site route, `/api/media/<id>?exp=…&sig=…`, signed with HMAC and valid for 1 hour. In Supabase mode they are Storage signed URLs. The worker downloads, then uploads to Postiz with multipart, as in amendment 01.
- **Cards.** These are rendered server-side with `next/og` (`ImageResponse`), using the Plus Jakarta Sans files shipped in `node_modules/@fontsource`. There are 6 formats (PRD 10.5), 3 templates (Light, Dark, Mint) and 3 brands, and every format/template/brand combination must render. A rendered card is stored as a media object like an upload, so it has a hash and is part of the approval hash.

## 3. Completed workstreams and their acceptance criteria

Shared rules for every workstream:
- Work only in this repo, and run npm only inside Linux/WSL.
- Keep `npm run ci` in `site/` green; also keep the worker type check and tests green.
- Every feature must work with `DB_MODE=local`.
- Changes to shared files (`constants.ts`, `schemas.ts`, `fake-supabase.ts`, `AdminNav.tsx`) are additive, appended in a section marked with the workstream's name.
- New server actions and queries go in new files, one per workstream.
- Each workstream has a reserved migration number; it may add that file and no other.

| WS | Branch | Scope (PRD refs) | Migration | Done when |
| --- | --- | --- | --- | --- |
| W1 | `feat/w1-approval` | **Approval and scheduling.** Times per destination, "suggest slot" (F4 Should), the "figures checked" confirmation, approve with an aal2 session and all hard checks (F5, 8.2), cap per Bucharest day, approval and jobs in one transaction (existing SQL functions). Cancel a destination or the whole post. "Retry failed destinations only". Reschedule or edit after approval makes a new revision, needs a new approval and cancels the old revision's unsubmitted jobs. Posts list with status per destination and the public URL. Pages: `/admin/social/postari` and `/admin/social/postari/[id]`; the draft editor gets a link to the post page. | `0003_*` | PRD 14 checks 1–4 pass as tests. A draft goes from the editor to approved jobs, and the fake worker publishes them. |
| W2 | `feat/w2-media-cards` | **Media and cards** (F3, F4 media and preview parts). Local disk storage plus the Supabase path, upload flow with metadata stripping, sha256, dimensions and required alt text. Media library page `/admin/social/media`. Card renderer: every format/template/brand combination, generated from the draft's card spec, editable headline, keyword, stat and subline. Attach cards and uploads to destinations, with a media panel in the draft editor. Per-destination preview with its card. `/api/media/<id>` signed URLs for the worker. | `0004_*` | Every format/template/brand combination renders (test). Upload strips EXIF. Attached media changes the destination hash. The worker can download media by URL in local mode. |
| W3 | `feat/w3-accounts-overview` | **Accounts, overview, calendar, manual handoff, events** (F1, F8, F10, A10). Accounts screen `/admin/social/conturi`: synced and manual-only accounts, assign to brand, mode, cap 1–5, pause, status badges, "Open editor" URL, worker last seen and last sync with warnings. Overview `/admin/social`: approval queue, today and upcoming, failures, reconnects, worker health, `social_events` feed with "mark as seen". Calendar `/admin/social/calendar`: week view in Bucharest time with status and public URL. Manual handoff (flow 6.2): copy formats, downloads, open editor, checklist, mark published with URL. Duplicate a post as a new draft (F10 Should). Owns `AdminNav.tsx`, including links to W1's and W2's pages. | `0005_*` | The manual flow completes end to end with the fake worker. Every account state can be managed from the UI, with no Supabase Studio needed. |
| W4 | `feat/w4-worker` | **Worker and generator** (`worker/`, plus the site side of one contract addition). Claude via structured outputs (JSON Schema, `stop_reason` checked), and Gemini with a response JSON schema. Prompts for `article` and `launch` kinds, so article fields and the launch kit are filled. Keep the model's sourced figures and add `unverified` entries only for numbers it did not list. Do not report `contains_figures` as a validation error. X weighted length. Fix the bare-domain check for URLs without a path. Fix `WORKER_DRY_RUN=false`, which currently stays true. **Generation heartbeat**: `POST /generation/{id}/heartbeat` (site route, SQL function and OpenAPI), used by the worker during long generate-plus-repair runs. Mock site updated. | `0006_*` | Worker type check and tests are green, including new tests. A generate-plus-repair run longer than the lease no longer loses its drafts (test). |

## 4. Out of scope here (needs an external service or a person)

These are left as they are, with steps documented in `docs/setup.md` where they exist:
- A Supabase project, and the switch from local mode.
- The VPS (B4).
- Postiz platform connections and developer apps (B2), and the tunnel for Meta (B10).
- Real test posts (B11, L2+).
- n8n (B8), email or Telegram notifications, and the automation API (10.4, still deferred).

## 5. Integration and the end-to-end check

The integrator merges W1–W4 into `main`, resolves conflicts and runs `scripts/update.sh`. Then, on a fresh local database:
1. Create an admin, log in and enrol TOTP. This is covered by tests, because the browser step needs a person.
2. Run the account sync (fake worker `--sync`), then assign accounts to brands and unpause them in the accounts screen.
3. Generate drafts with the fake generator, edit one and attach a card.
4. Schedule, check figures and approve.
5. The fake worker claims the job, downloads the media URL and reports it published. The overview and calendar show the public URL.
6. Do a manual handoff for a Substack destination, ending with "mark published".

The worker in dry run (`WORKER_DRY_RUN=true`) against the local site claims and reports a job without calling Postiz.
