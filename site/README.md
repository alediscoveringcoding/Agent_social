# site/

Track A of the social publishing PRD: the `/admin/social` app and the worker API, as a standalone Next.js app with its own Supabase project.

Specs: [PRD](../docs/PRD.md), [amendment 01: localhost MVP](../docs/amendment-01-localhost-mvp.md), [amendment 02: standalone site](../docs/amendment-02-standalone-site.md). Contracts for the worker: [`../docs/contracts/`](../docs/contracts/).

> This repository is public. `.env.local` is git-ignored; never put real keys, tokens, handles or the operator's legal name in a tracked file.

## Status

| Task | What | State |
| --- | --- | --- |
| A1 | Schema, RLS, guard triggers, state machine as SQL functions, seed brands (`supabase/migrations/0001_…`, `0002_…`) | Done, tested on PGlite |
| A2 | Worker API v1 (PRD 10.3), token auth, kill switch, event outbox | Done, tested in process |
| A3 | Fake worker and fake generator (`scripts/`) | Done, tested in process |
| A4, A5, A7, A8, A9, A10 | `/admin/social` screens | In progress |
| A6 | Card renderer | Not started |
| Automation API (PRD 10.4) | | Deferred (amendment 01) |

Nothing has run against a real Supabase yet: Docker and the Supabase CLI were not available while this was built. All database behaviour is tested on PGlite (Postgres in WASM) built from the same migrations.

## Install and check

Node 22.6 or newer.

```bash
cd site
npm install
npm run ci        # typecheck, lint, tests, production build
```

| Script | Does |
| --- | --- |
| `npm run dev` | Next dev server on `http://127.0.0.1:3000` |
| `npm test` | node:test: pure libraries, PGlite database tests, worker API and fake worker end to end |
| `npm run social:fake-worker` | Fake worker against the running site (see the script header for options) |
| `npm run social:fake-generator` | Fake generator: delivers fixture drafts, some deliberately invalid |
| `npm run admin:create` | Create an admin user in this app's Supabase Auth |

## Run it locally (once Docker and the Supabase CLI are installed)

See "Run it locally" at the end of this file (written with the admin screens).

## Layout

```
supabase/migrations/   0001 social schema + functions + seeds, 0002 activity log
src/app/api/worker/social/v1/   worker API route handlers
src/lib/social/        content rules, hash, validation, time, draft mapping, worker API helpers
src/lib/social/fake/   fake worker / generator logic (used by scripts and tests)
src/lib/testing/       PGlite harness, fake PostgREST client, in-process route fetch
test/                  node:test loader (resolves @/, stubs server-only, swaps the admin client)
scripts/               fake worker, fake generator, admin creation
```
