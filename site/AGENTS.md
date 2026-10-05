<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# site/: notes for agents

Track A of `../docs/PRD.md`, as amended by `../docs/amendment-01-localhost-mvp.md` and `../docs/amendment-02-standalone-site.md`.

- **This repository is public.** No secrets, real handles or the operator's legal name in any file. `.env.local` is git-ignored; `.env.example` holds placeholders only.
- **The browser never writes the database.** Every `social_*` table has RLS on, no policies and no rights for `anon` / `authenticated`. Server code uses `createAdminClient()` (`src/lib/supabase/admin.ts`, service role) after `requireAdmin()` (`src/lib/auth/admin.ts`: allowlisted email AND a TOTP-verified session, aal2). Re-check inside every server action; a page-level check does not cover actions.
- **State changes go through the SQL functions** in `supabase/migrations/0001_social_publishing.sql` (`social_approve_revision`, `social_save_revision`, `social_job_*`, …). They hold the row locks and keep each transition in one transaction. Do not reimplement a transition as several PostgREST calls.
- **Contracts are frozen** (PRD 10). The worker API shapes are in `../docs/contracts/worker-api.openapi.yaml`; the hash vectors in `src/lib/social/__tests__/hash-vectors.json` are mirrored in `../docs/contracts/hash-vectors.json`. Never regenerate expected hashes to make a test pass.
- **Copy is Romanian without diacritics**, calm and short, like the PRD's examples.
- **Tests**: `npm test` runs node:test with `test/register.mjs` (resolves `@/`, stubs `server-only`, and swaps `@/lib/supabase/admin` for a PGlite-backed client, `src/lib/testing/`). Database tests build PGlite from `supabase/migrations/`. Verify with `npm run ci`.
- **Upserts**: `onConflict` must name a plain unique index or constraint, never a partial or expression index (PostgREST cannot target those).
- Scripts in `scripts/` talk to the site over HTTP only, like the real worker.
