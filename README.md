# social-infra

Infrastructure for cross-posting and automation behind `/admin/social` on thecrypto.support.

This repo contains the admin site, database migrations, approval rules and publishing worker, plus the local Postiz stack and infrastructure scripts. The site currently runs with local PGlite and TOTP login; Vercel, Supabase and VPS setup are documented for later deployment.

Status: local v1 implemented and tested. External platform connections and VPS deployment remain pending. Publishing requires admin approval.

Product requirements and the work split: [docs/PRD.md](docs/PRD.md). Where this README and the PRD differ, the PRD wins until this README is updated.

Current phase: **local v1 complete on `main`**, verified on 2026-10-06. [Amendment 03](docs/amendment-03-finish-the-site.md) defines the completed local scope; external setup follows later.

## Progress on main

| Workstream | Delivered | Status |
| --- | --- | --- |
| W1: approval and scheduling | Posts pages, Bucharest slots and daily caps, figures gate, approve/cancel/retry/reschedule, frozen approved revisions | Complete locally |
| W2: media and cards | Private disk storage, signed uploads/downloads, EXIF/GPS stripping, media library, card studio and previews; all 54 format/template/brand combinations | Complete locally |
| W3: accounts and operations | Synced/manual accounts, brand assignment, modes/caps/pause, overview/events, DST calendar, manual handoffs and duplicate | Complete locally |
| W4: worker and generator | Claude/Gemini structured output, content validation and repair, generation lease heartbeats, media checksum verification and dry-run delivery | Complete locally |

Final review fixed approval checks for the actual attached card, immutable card metadata (migration `0007`), competing media/text edits, and consistent keyword matching. All four branches were merged into `main`; the feature branches remain available.

**Verified:** `bash scripts/update.sh --no-pull` passed with 276 site tests and 27 worker tests (at amendment 03; after amendment 05: `npm run ci` 361 site tests and 65 worker tests, both green), type checks, lint, migrations and a production build. HTTP smoke checks covered 16 authenticated pages, login redirects, both DST weeks, card previews and signed image downloads. The combined flow uses a fresh local database: fake generation → edit/card → approval → media download → published URL in overview/calendar, plus manual publication and the production worker in dry run. No real AI or platform API calls were used for acceptance. After amendment 04 (every Postiz provider, 35 platforms): `npm run ci` in `site` with 341 tests and a production build, and 63 worker tests.

**Remaining:** real Postiz sandbox validation and platform connections/developer approvals; Supabase/Vercel staging and VPS setup; controlled real posts and a restore drill. n8n, the automation API and email/Telegram notifications are deferred. See [site/README.md](site/README.md) to run the app and [the completed handoff](docs/handoff-codex.md) for validation details.

## How it fits together

```mermaid
flowchart LR
  A[Admin with TOTP] -->|edit, approve, schedule| S[Local Next.js site]
  F[Fake generator and worker] -->|offline local flow| S
  S --> DB[(PGlite and private images)]
  S --> M[Manual handoff]
  W[Local worker] -->|claim and report dry-run results| S
  W -.->|after external setup| P[Postiz]
  P -.-> PL[Platform accounts]
```

Rules that never change:

1. Future automation can only create drafts and report workflow results. It cannot approve or publish.
2. The site database owns the schedule: PGlite locally, Supabase after migration. Postiz and automation keep no second schedule.
3. Only the worker holds a Postiz API key.
4. Postiz holds platform credentials. The site never sees them.
5. Approval is tied to the exact content, media, accounts and time. Any edit invalidates it.

## Repo layout

```
social-infra/
  package.json              root workspace (worker)
  local/
    docker-compose.yml       Postiz v2.25.0 + Postgres + Redis + Temporal
    .env.example
  site/                     Next.js admin, local database, media and worker API
  worker/
    src/
      loops/                 delivery, generator, sync
      services/              site-api, postiz-api, claude-api
      generator/             prompts, schema, validators, repair
      delivery/              hash (+ hash.test), the publish/poll/reconcile
                             handlers live in loops/delivery.ts
      utils/                 health
    test/
      mock-site.mjs          stands in for Track A's site (PRD task B9)
    .env.example
  prompts/
    facts.yaml, banned.txt, system.md, social.md
  scripts/
    dev-up.mjs, dev-down.mjs, health-check.mjs, backup-local.mjs
  card-templates/
    index.html               static brand-card design reference (not rendered by the worker)
  supabase/
    migrations/0001_social_schema.sql   reference copy; Track A owns the real one
  docs/
    PRD.md, amendment-01-localhost-mvp.md, setup.md, postiz-notes.md
    contracts/hash-vectors.json
  README.md
```

The VPS phase (Caddy, two subdomains, n8n, `.github/workflows/`) comes later — see "Moving to a server later" in the amendment.

## Services

| Service | Purpose | Notes |
| --- | --- | --- |
| Postiz | Platform connections, publishing, analytics | Pin the image version. Recent versions need Temporal |
| PostgreSQL + Redis | Postiz data and job queue | Not exposed publicly |
| Temporal | Workflow engine required by recent Postiz | Its own database |
| n8n | Automations that create drafts | Separate database and credentials |
| Worker | Claims approved jobs, submits to Postiz | Talks to the site over HTTPS |
| Caddy | HTTPS and reverse proxy | Two subdomains |

Domains (example, adjust to yours):

- `social.thecrypto.support` for Postiz
- `n8n.thecrypto.support` for n8n

Starting size (VPS phase): 4 vCPU, 8 GB RAM, persistent storage, EU region. Watch usage before upsizing.

## Running the local app on main

Use Linux/WSL for Git, npm and Node. With the site stopped, run from the repo root (replace the example email with your allowlisted address):

```bash
bash scripts/update.sh --no-pull --admin-email you@example.com
cd site
npm run admin:create -- --email you@example.com  # first-time setup only
npm run dev
```

Open **http://localhost:3000/login**, use the password printed once by `admin:create`, and enroll TOTP. For an existing local account, `npm run admin:create -- --email you@example.com --reset` prints a new password and removes its authenticator; enroll TOTP again. Account reset preserves drafts and media.

In another WSL terminal, from `site/`, use `npm run social:fake-worker -- --sync`, assign brands and unpause the fake accounts in **Conturi**, then request drafts in **Genereaza** and run `npm run social:fake-generator -- --once`. The [site guide](site/README.md#run-locally-without-docker) continues through editing, media, figures, approval and publication. Docker and AI keys are optional for this flow.

For production-worker dry runs, keep AI keys blank and `WORKER_DRY_RUN=true`, point it at the running local site with the matching `WORKER_TOKEN`, then run `cd worker && npm run dev` from the repo root. It downloads approved media and reports test results without calling Postiz; use fake account sync locally. The mock site in `worker/test/mock-site.mjs` remains a worker-test fixture.

### Postiz sandbox (external setup still pending)

`node scripts/dev-up.mjs` starts the local Postiz/Temporal stack on http://localhost:4007. Create its user/API key, configure `worker/.env`, close registration and connect a throwaway account before testing real delivery. [docs/setup.md](docs/setup.md) and [docs/postiz-notes.md](docs/postiz-notes.md) track the remaining setup and API checks.

## Environment

Only placeholders live in git (`.env` is git-ignored everywhere). Real values stay on each developer's or the publisher machine.

- [local/.env.example](local/.env.example) — Postiz JWT secret, registration toggle, provider credentials as each platform is connected.
- [site/.env.example](site/.env.example) — database mode, admin allowlist, local auth/media signing secrets, worker token and the publishing kill switch.
- [worker/.env.example](worker/.env.example) — site URL/token, Postiz key, optional Claude/Gemini keys, generation provider/model/effort, heartbeat and loop intervals, dry-run setting. Keep AI keys blank for offline use.
- Generator style: public rules in `prompts/style/` and `prompts/brands/`; an optional private pack in `prompts/private/` (git-ignored, `STYLE_PACK_DIR`), template in `prompts/private.example/`: [amendment 06](docs/amendment-06-style-packs.md).

In the VPS phase these move to Vercel/VPS env and gain `N8N_AUTOMATION_TOKEN`, `N8N_ENCRYPTION_KEY`, a real `POSTIZ_URL` domain, and n8n's own env — see the amendment, section 11.

## Publishing flow

1. An admin requests drafts in **Genereaza**. The fake generator or configured production generator delivers them through the worker API; the automation API is deferred.
2. An admin edits and approves it in `/admin/social`. Approval stores a hash of the exact content.
3. Approval creates one delivery job per destination, in the same transaction.
4. The worker claims due automatic jobs, checks the approval hash and media bytes, and either reports a dry-run result or submits to Postiz when real delivery is configured. Manual jobs become due for handoff.
5. The worker reports the Postiz ID, the result and the published URL per destination.

Failure handling:

- Definite transient failure: retry with backoff.
- Timeout or unknown result: mark `reconciling` and check Postiz before doing anything else. Never recreate a post that may exist.
- One platform failing never rolls back the others.
- Times are stored in UTC and shown in Europe/Bucharest.

## n8n workflows (deferred)

These remain a later phase; local v1 uses generation requests and the in-app event feed.

| Workflow | What it does |
| --- | --- |
| Article to drafts | New blog article creates editable drafts with the canonical link |
| Campaign to draft | Admin-configured templates and calendars create drafts |
| Results to notifications | Failures and reconnect-needed alerts reach the admin |
| Analytics refresh | Daily metrics pull, weekly internal summary |

Conventions:

- Workflows change through pull requests, exported to `n8n/workflows/`. No editing in the UI on production.
- Authenticated webhooks, an event ID on every run, idempotent draft creation.
- Plain HTTP Request nodes against our own endpoints. The community Postiz node is not used for publishing, because it would hand n8n a key that bypasses approval.
- AI generation creates drafts only; a person approves. The offline flow uses the fake generator.

## Platform coverage

| Platform | Target mode after setup |
| --- | --- |
| dev.to, Hashnode, X, Facebook, Instagram | Automatic when the channel and permissions are configured; X needs a billing cap |
| LinkedIn (company page and personal profile) | Manual until developer approval, then automatic |
| Threads, Bluesky, Mastodon, Reddit, Pinterest, Telegram, Discord, Medium, Farcaster, Nostr, Lemmy | Automatic through Postiz once the channel is connected ([amendment 04](docs/amendment-04-more-platforms.md)); most need a developer app or platform approval first (check each platform's current terms), and an account can wait in manual mode meanwhile |
| Slack, WordPress, Listmonk, VK, Google Business, Tumblr, Dribbble, MeWe, Skool, Whop, Moltbook, Kick, Twitch, TikTok (photo posts) | Automatic through Postiz once the channel is connected (amendment 04, second batch) |
| Substack, Product Hunt, YouTube | Manual handoff (YouTube needs video, which is uploaded by hand) |
| Quora, LinkedIn (articol), TradingView, Investing.com, Indie Hackers, Stack Exchange, GitHub, Forum, Presa (comunicat) | Manual handoff, always ([amendment 05](docs/amendment-05-manual-channels.md); forum and press accounts are one per forum or outlet, created by hand; the per-site research is in [visibility-channels](docs/visibility-channels.md)) |

Forty-four platforms in all: every provider of the pinned Postiz `v2.25.0` (36 identifiers, of which four are aliases) plus Substack, Product Hunt and the nine manual channels of amendment 05. Some need a field the generator cannot know (a subreddit, a Pinterest board, a Discord or Slack channel, a Lemmy community, a Listmonk list): a person fills it in the composer, and approval waits for it. Limits and sources are in the [PRD platform tables](docs/PRD.md#5-scope-brands-accounts-platforms); server variables per provider are in [setup.md](docs/setup.md).

Images are supported in local v1; video is outside its scope, so TikTok gets photo posts and YouTube a manual handoff. Real platform connections and controlled posts remain pending; [PRD section 5](docs/PRD.md#5-scope-brands-accounts-platforms) owns the platform requirements.

Every account shows one of: connected, reconnect required, developer setup required, approval pending, manual publishing.

## Data model

The authoritative schema is in `site/supabase/migrations/`, applied to PGlite locally and to Supabase when that environment is configured. Overview:

| Table | Purpose |
| --- | --- |
| `social_brands` | Brands, for example The Crypto Support, Comets of Web3 |
| `social_accounts` | Connected accounts, identified by provider account ID, many per platform |
| `social_media` | Uploaded/generated images, immutable bytes/hash/card metadata, suggested alt text |
| `social_posts` | A post and its overall status |
| `social_post_revisions` | Every edit creates a new revision |
| `social_destinations` | Per-account version of a revision: text, settings, time |
| `social_destination_media` | Ordered media per destination |
| `social_approvals` | Approval bound to a revision and a content hash |
| `social_delivery_jobs` | One job per destination, with lease, retries and Postiz result |
| `social_analytics_snapshots` | Metrics per account or destination, with an unavailable flag |
| `social_generation_requests` | Generation inputs, lease, outcome and draft counts |
| `social_publish_attempts` | Submission/reconciliation history for each job |
| `social_events` | Outbox and in-app event feed |
| `social_workers` | Worker heartbeat and account-sync health |
| `social_upload_tickets` | Durable one-use upload phases and expiry |
| `social_automation_runs` | Reserved for future automation, unique per workflow and event ID |

```mermaid
erDiagram
  social_brands ||--o{ social_accounts : has
  social_brands ||--o{ social_posts : owns
  social_posts ||--o{ social_post_revisions : has
  social_post_revisions ||--o{ social_destinations : has
  social_accounts ||--o{ social_destinations : targets
  social_destinations ||--o{ social_destination_media : uses
  social_media ||--o{ social_destination_media : used_in
  social_post_revisions ||--o{ social_approvals : approved_by
  social_destinations ||--|| social_delivery_jobs : delivered_by
  social_accounts ||--o{ social_analytics_snapshots : measured
```

Data rules:

- Row Level Security is on for every social table with no policies. Only server code using the service role can touch them. Browsers never write.
- A unique index on `social_delivery_jobs.destination_id` blocks duplicate submissions.
- Jobs are claimed with `for update skip locked` and a lease.
- An expired lease on a job that may already have reached Postiz goes to `reconciling`, not back to the queue.

## Security

- Admin-only endpoints use the existing admin auth, MFA and activity logging. No admin actions while impersonating a user.
- No Supabase service-role key, approval permission or Postiz key is ever given to n8n.
- Platform credentials stay in Postiz; the site stores no platform passwords.
- `.env` never enters git. Pin container versions, no `latest`.

## Backups and restore

The local Postiz backup helper is `scripts/backup-local.mjs`. Site data and private images live under `site/.local-db/` (or `LOCAL_DB_DIR`); stop the site before copying them together. Automated VPS backups and a clean-machine restore drill remain pending before real accounts are enabled.

## Implementation phases

- [x] 0a. Worker delivery/generator/sync loops, Claude/Gemini structured output, generation heartbeats, canonical hash vectors, safe dry run and offline HTTP acceptance
- [ ] 0b. Local sandbox: run Postiz for real, create an API key, create a post through the API, check the real rate limit (task B3, `docs/postiz-notes.md`)
- [ ] 1. VPS, DNS, compose stack, HTTPS, backups with one test restore (deferred — localhost MVP first, see the amendment)
- [ ] 2. Developer apps and callback URLs, first real connection (dev.to/Hashnode first, then LinkedIn, Facebook, Instagram)
- [x] 3. Local site foundation: migrations, authenticated admin, worker API and publishing feature flag
- [x] 4. Local full flow: draft, media, approve, schedule, fake/dry-run publication and URL, plus manual handoff
- [ ] 5. n8n workflows (dropped from the localhost MVP, see the amendment)
- [ ] 6. Analytics, then enable remaining accounts one at a time

## Acceptance checks

These remain the production criteria. Local validation is recorded under **Progress on main**; real posts, external integration and restore verification are still pending.

- Non-admins, sessions without MFA and n8n credentials cannot approve or publish.
- Editing approved content invalidates the approval.
- Concurrent workers, repeated events and restarts create no duplicates.
- Ambiguous results require reconciliation.
- Expired connections and partial failures stay visible and recoverable.
- Image uploads strip metadata; signed downloads and checksums preserve the approved media.
- Scheduling survives Bucharest daylight-saving changes.
- Paid-only platforms never trigger automatic API charges.
- Every connected destination has a successful controlled test post. Manual destinations have a full handoff.
- Backups restore the services and their connections.

## Out of scope

Comments, inboxes, advertising, video and analytics dashboards are outside the current local scope.

## Notes

- Postiz is AGPL-3.0. Running it unmodified behind its API is fine. Talk to the team before modifying it.
- Platform API rules are separate from Postiz. Check each platform's current terms before enabling it.
