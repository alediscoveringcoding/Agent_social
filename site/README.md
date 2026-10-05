# site/

The `/admin/social` app and worker API, as a standalone Next.js app. Today it runs in temporary local mode with PGlite and disk storage; Supabase remains the later deployment path.

Specs: [PRD](../docs/PRD.md), [amendment 01: localhost MVP](../docs/amendment-01-localhost-mvp.md), [amendment 02: standalone site](../docs/amendment-02-standalone-site.md). Contracts for the worker: [`../docs/contracts/`](../docs/contracts/).

> This repository is public. `.env.local` is git-ignored; never put real keys, tokens, handles or the operator's legal name in a tracked file.

## Status

| Task | What | State |
| --- | --- | --- |
| A1 | Schema, RLS, guard triggers, state machine as SQL functions, seed brands (`supabase/migrations/0001_…`, `0002_…`) | Done, tested on PGlite |
| A2 | Worker API v1 (PRD 10.3), token auth, kill switch, event outbox | Done, tested in process |
| A3 | Fake worker and fake generator (`scripts/`) | Done, tested in process |
| Admin auth | Login (Supabase Auth, `ADMIN_EMAILS`), TOTP enrol/verify, aal2 on every page and action, nonce CSP in `src/proxy.ts`, `npm run admin:create` | Done; decision logic unit-tested, flow not yet run against Supabase |
| A5 | Generate form (`/admin/social/genereaza`) and drafts inbox (`/admin/social/ciorne`) | Done, actions tested on PGlite |
| A4 / A7 (editing part) | Draft editor (`/admin/social/ciorne/[id]`): destinations per account, text and settings per platform, live content rules, figure confirmation, revisions | Done |
| Media (F3/F4) | Private local disk storage and Supabase uploads, media library, destination attachment and alternative text | Done, local upload and download flow tested |
| A7 (rest), A8, A9, A10 | Approval, cancel/retry/reschedule, posts list, manual handoff, overview and calendar | Done locally, including fake-worker flows |
| A6 | Card renderer, card studio and destination preview | Done; all 54 format/template/brand combinations tested |
| Accounts | Synced and manual accounts, brand assignment, pause, modes, caps and worker health | Done; managed from Conturi |
| Automation API (PRD 10.4) | | Deferred (amendment 01) |

Nothing has run against a real Supabase yet: Docker and the Supabase CLI were not available while this was built. All database behaviour is tested on PGlite (Postgres in WASM) built from the same migrations.

## Install and check

Node 22.6 or newer.

```bash
cd site
npm ci
npm run ci        # typecheck, lint, tests, production build
```

| Script | Does |
| --- | --- |
| `npm run dev` | Next dev server on `http://127.0.0.1:3000` |
| `npm test` | node:test: pure libraries, PGlite database tests, worker API and fake worker end to end |
| `npm run social:fake-worker` | Fake worker against the running site (see the script header for options) |
| `npm run social:fake-generator` | Fake generator: delivers fixture drafts, some deliberately invalid |
| `npm run admin:create` | Create an admin in local mode or local Supabase Auth |

## Run locally without Docker

Run npm only inside Linux/WSL, never from Windows.

1. From the repo root: `bash scripts/update.sh --no-pull --admin-email you@example.com`. It installs dependencies, creates ignored environment files, applies migrations and checks both packages.
2. With the site stopped: `cd site && npm run admin:create -- --email you@example.com` (replace the example address with your allowlisted email). The script generates a password and prints it once; save it. To choose one, add `--password 'your-password-at-least-12-characters'`. For an existing local account, `--reset` generates a new password and removes its authenticator, which must be enrolled again.
3. `npm run dev`, open `http://localhost:3000/login`, sign in and enroll TOTP.
4. `npm run social:fake-worker -- --sync`; open **Conturi** to assign brands and unpause the fake channels. Create manual Substack/Product Hunt accounts there.
5. Request drafts in **Genereaza**, then `npm run social:fake-generator -- --once`. Edit in **Ciorne**, upload JPEG/PNG/WebP in **Media**, or generate and attach cards in the editor. Uploads strip EXIF/GPS metadata; attachment alt text is saved per revision.
6. Open **Programare si aprobare**, choose times, confirm figure sources and tick **Am verificat cifrele** where needed. Set `SOCIAL_PUBLISHING_ENABLED=true` in the ignored site environment when ready to exercise local delivery, then restart the site.
7. For due jobs: `npm run social:fake-worker -- --once --scenario ok --download-media`; run again when the poll is due. Public links appear in **Postari**, **Prezentare** and **Calendar**. **Publicare manuala** offers copy/download formats, images and publication confirmation.
8. The production worker with `WORKER_DRY_RUN=true` downloads and verifies approved media and reports a test URL without contacting Postiz. Dry run skips account sync, polling and reconciliation; use fake sync locally. Keep AI keys blank for an offline run.

Private database and storage data are under `site/.local-db/`. Stop the site before database maintenance. `npm run db:reset -- --yes` deletes local data; use it only for a disposable environment.

## Run against local Supabase (optional later setup)

1. In `site/`: `npm install`, then `supabase init` (keeps `supabase/migrations/`). In the generated `supabase/config.toml` turn TOTP on (`[auth.mfa.totp]` `enroll_enabled = true`, `verify_enabled = true`) and public signup off (`[auth]` `enable_signup = false`).
2. `supabase start`. Apply every migration in `supabase/migrations`; the three brands and the `social-media` bucket are seeded. `supabase db reset` rebuilds the same (and wipes data).
3. Copy `.env.example` to `.env.local` and fill it from `supabase status` (URL, anon key, service role key). Set `ADMIN_EMAILS`, `WORKER_TOKEN` (`openssl rand -hex 32`, same value in the worker's env) and, when testing delivery, `SOCIAL_PUBLISHING_ENABLED=true`.
4. `npm run admin:create -- --email you@example.com` (refuses a non-local Supabase).
5. `npm run dev`, open `http://localhost:3000/login`, sign in, enrol the authenticator.
6. Without Track B running: `npm run social:fake-worker -- --sync` registers six fake channels. Open **Conturi** (`/admin/social/conturi`), assign each channel to a brand and unpause it. Create a request in **Genereaza**, run `npm run social:fake-generator -- --once`, and the drafts appear in **Ciorne**. Create Substack and Product Hunt accounts in **Conturi** for the **Publicare manuala** flow.
7. With Track B: point the worker's `SITE_BASE_URL` at `http://localhost:3000` with the same `WORKER_TOKEN`.
8. Concurrency check on real Postgres: `npm run social:fake-worker -- --race 8` (needs approved, due jobs).

## Media and cards

In local mode, private images live under `LOCAL_DB_DIR/storage/social-media/`
(default `site/.local-db/storage/social-media/`). Keep this directory with the
database when backing up. Download links are signed for at most one hour;
`MEDIA_SIGNING_SECRET` can supply a separate key, otherwise the site uses
`LOCAL_AUTH_SECRET` or `SUPABASE_SERVICE_ROLE_KEY` (at least 32 characters).

Open **Media** to upload JPEG, PNG or WebP files up to 8 MB with alternative
text. Uploads apply orientation and remove EXIF/GPS and other metadata. In a
draft, save any text changes before attaching images or generating cards.
Both operations save a new revision. Changing a library image's suggested
alternative text leaves existing revisions' copies unchanged; edit the attached
text in the draft to change what will be published. Images used by any revision
cannot be deleted. Card numbers newly introduced by an edit are listed as
unverified figures until a person checks them.

To exercise signed media downloads and checksum validation against a running
local site, use `npm run social:fake-worker -- --once --scenario ok --download-media`.

## Layout

```
supabase/migrations/   schema, activity, media tickets, accounts, generation heartbeat and media immutability
src/app/api/worker/social/v1/   worker API route handlers
src/lib/social/        content rules, hash, validation, time, draft mapping, worker API helpers
src/lib/social/fake/   fake worker / generator logic (used by scripts and tests)
src/lib/testing/       PGlite harness, fake PostgREST client, in-process route fetch
src/lib/local/         temporary local database, login and private disk storage
test/                  node:test loader (resolves @/, stubs server-only, swaps the admin client)
scripts/               fake worker, fake generator, admin creation
```
