# Amendment 02: Standalone site

| | |
| --- | --- |
| Status | Draft, ready for review |
| Date | 2026-10-05 |
| Amends | [PRD](PRD.md), [Amendment 01](amendment-01-localhost-mvp.md) |
| Decision | Track A is its own Next.js app in `site/` of this repo, with its own Supabase project. It is not part of the website. |

The PRD and amendment 01 still hold. This amendment says what changes now that the admin app no longer lives inside the website repository.

---

## 1. What stays exactly the same

- The contracts of PRD section 10: data model, state machines, worker API (`/api/worker/social/v1`, same paths and bodies), draft and card spec, content hash, error codes.
- Content rules (PRD 8), approval rules (F5), the daily cap of 5 per account per Bucharest day, the stale window, the kill switch, dry run.
- Amendment 01: localhost MVP, no n8n, automation API deferred, calendar as a list, tasks A0 and A10.
- The admin screens live under `/admin/social` (the paths in the PRD keep working; `/` redirects there).

## 2. What changes

| PRD / amendment 01 item | Standalone site |
| --- | --- |
| `/admin/social` inside the website (Next.js on Vercel) | A separate Next.js app in `site/` of this repo, `npm run dev` on `http://localhost:3000`, bound to `127.0.0.1` |
| The website's Supabase project (amendment 01: local Supabase in the website repo) | **Its own Supabase project**: local Supabase CLI started in `site/` (`supabase start`) once Docker is installed. A dedicated cloud project later. Never the website's project |
| Migrations numbered after the website's (`19x_…`) | `site/supabase/migrations/0001_…`, `0002_…`; `supabase db reset` rebuilds everything, seed brands included |
| "Existing site admins with MFA", website roles, impersonation guard | **Supabase Auth email + password**, signup disabled, restricted to an `ADMIN_EMAILS` allowlist. **TOTP MFA is required (aal2) for every admin page and action**, approval included (PRD 4 and F5). No impersonation exists, so there is nothing to guard |
| The website's activity log | `social_activity_log` table in the site's own database (who, what, which post/job, details, when), insert-only |
| Website conventions (its admin client, CSP nonce helper, its test harness) | The site has its own: a service-role client in `src/lib/supabase/admin.ts`, a nonce-based CSP set by `src/proxy.ts`, and a PGlite test harness that applies `supabase/migrations/` over a stub of the Supabase-provided schemas |
| Brand look | The PRD 8.3 palette as Tailwind tokens (light and dark), Plus Jakarta Sans shipped with the app (no font download at build time); the same font files feed the card renderer |
| Tests against a database | PGlite (Postgres in WASM) in `npm test`, so the state machine and the worker API are tested without Docker. A real-Postgres concurrent claim check runs with the fake worker (`--race`) once local Supabase exists |

Admin users are created by hand: in Supabase Studio (`http://127.0.0.1:54323`) or with `npm run admin:create` (service role, email confirmed). Their address must also be in `ADMIN_EMAILS`. On first login the app asks them to enrol a TOTP authenticator; without it no admin screen opens.

## 3. What this means for Track B

Nothing in the worker contract changes. `SITE_BASE_URL` is `http://localhost:3000` as in amendment 01, and signed media URLs point at the site's own local Supabase (`http://127.0.0.1:54321`). The fake worker and fake generator in `site/scripts/` show the expected calls end to end; `docs/contracts/worker-api.openapi.yaml` and `docs/contracts/hash-vectors.json` are the reference.

## 4. Moving to a server later

1. Create a cloud Supabase project for the site (not the website's) and apply `site/supabase/migrations/`.
2. Deploy `site/` (Vercel or the VPS) with its own env: Supabase URL and keys, `WORKER_TOKEN`, `ADMIN_EMAILS`, `SOCIAL_PUBLISHING_ENABLED`.
3. Point the worker's `SITE_BASE_URL` at it. No contract changes.

## 5. New open questions

| # | Question | Default |
| --- | --- | --- |
| S1 | Should the app ever merge back into the website's admin? | No; it stays separate |
| S2 | Who is in `ADMIN_EMAILS`? | Raul and Ale |
| S3 | MFA on every admin screen, or only for approval? | Every screen (PRD 4: admin actions need MFA) |
| S4 | Operator legal name for the "no legal name" check (`SOCIAL_LEGAL_NAMES`) | Set in `.env.local` only; never in this public repo |
