# Setup

Everything runs in WSL (Linux) with Node 22.6 or newer: the Next.js site and the TypeScript
worker. There is no Postiz, Docker, Redis or Temporal (amendment 10). The README's
[Running the app](../README.md#running-the-app) section has the full first-time setup.

## Try it without real accounts

1. With the app stopped, run `npm run db:test-accounts` from `site/` (local mode). It adds one
   paused test account per platform. Native test accounts hold a placeholder credential, so a
   real publication would fail before any request.
2. Start the app (`bash scripts/dev-local.sh`), assign brands and unpause the test accounts in
   `/admin/social/conturi`, then request drafts in **Genereaza** (pick **Scurta** or **Lunga**).
3. Without an AI key, `npm run social:fake-generator -- --once` answers a request with test drafts;
   `npm run social:fake-worker -- --once --scenario ok` publishes due jobs to fake URLs.

For an offline production-worker test keep `WORKER_DRY_RUN=true`. Dry run checks the approved hash
and reports a test URL; it never asks the site to publish or check a platform.

## Real accounts

Connect existing accounts directly in **Conturi** (OAuth or API credentials). The developer
applications, server settings and access each platform needs are in
[native-publishing.md](native-publishing.md); the API-first scope is in
[amendment 09](amendment-09-api-connections.md). Every new connection starts paused.

Real publishing needs `SOCIAL_PUBLISHING_ENABLED=true` in `site/.env.local` and
`WORKER_DRY_RUN=false` in `worker/.env`.

## Dropped platforms

Threads, Reddit, Pinterest, Nostr, VK, Google Business, Tumblr, Dribbble, Whop, Moltbook, Kick
and Twitch were not implemented and are dropped; WordPress, Discord and Mastodon were excluded.
See [amendment 10](amendment-10-postiz-removed-length.md).
