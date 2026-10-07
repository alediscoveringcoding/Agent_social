# Platform setup guide (localhost MVP)

## Local site without external services

The local site is complete under amendment 03. Run `bash scripts/update.sh --no-pull` in Linux/WSL, create an admin with `cd site && npm run admin:create -- --email you@example.com`, then start the site and enroll TOTP. See [site/README.md](../site/README.md) for the full workflow.

Use `npm run social:fake-worker -- --sync` from `site/`, assign brands and unpause channels in `/admin/social/conturi`, then run the fake generator. Uploads and generated cards use private disk storage and signed media URLs. Approval, manual handoff, overview and calendar are available in the admin navigation.

For an offline production-worker test keep AI keys blank and `WORKER_DRY_RUN=true`. Dry run downloads and verifies media but never calls Postiz; it skips Postiz sync/poll/reconciliation. The remaining sections apply when connecting real external services.

## Postiz initial setup

1. `node scripts/dev-up.mjs` (or `docker compose up -d` in `local/`)
2. Open http://localhost:4007
3. Create the admin user
4. Settings > Public API > generate an API key, put it in `worker/.env` as `POSTIZ_API_KEY`
5. Set `DISABLE_REGISTRATION=true` in `local/.env`, restart (`docker compose up -d` again in `local/`)

## Platform connections

### dev.to (1st priority)

- Auth: API key (no OAuth needed)
- Get key: https://dev.to/settings/extensions > Generate API key
- In Postiz: Settings > Integrations > dev.to > paste key
- Works on plain localhost: yes

### Hashnode (1st priority)

- Auth: Personal access token
- Get token: https://hashnode.com/settings/developer
- In Postiz: Settings > Integrations > Hashnode > paste token
- Works on plain localhost: yes

### X (2nd priority)

- Auth: OAuth
- Verify: does X's developer portal accept `http://localhost:4007` as a callback?
- If not: needs a tunnel (ngrok static domain or Cloudflare named tunnel)

### LinkedIn (2nd priority)

- Auth: OAuth
- Verify: does Postiz support a localhost redirect for LinkedIn?
- Manual posting until the Community Management API application is approved

### Facebook (3rd priority)

- Auth: OAuth
- Note: Meta fetches images from a URL it can reach — needs a tunnel or R2 for media

### Instagram (3rd priority)

- Auth: OAuth
- Same as Facebook; needs a public URL for images; Instagram Login may require HTTPS

### More platforms (amendment 04)

Connect each in Postiz (Settings > Integrations), then run an account sync (the worker does it, or `npm run social:fake-worker -- --sync` locally). The channel arrives in `/admin/social/conturi` paused and without a brand; assign a brand and unpause it. The site knows a channel by the `identifier` Postiz reports (`threads`, `bluesky`, `mastodon` or `mastodon-custom`, `linkedin`, `reddit`, `pinterest`, `telegram`, `discord`, `medium`, `wrapcast` for Farcaster, `nostr`, `lemmy`); any other provider is ignored and listed in the sync answer. What Postiz v2.25.0 asks for, from its provider source:

| Platform | What the Postiz server and the channel need (provider source, v2.25.0) | Ids the composer asks for |
| --- | --- | --- |
| Threads | Server env `THREADS_APP_ID`, `THREADS_APP_SECRET`; OAuth | none |
| Bluesky | The form asks for service URL (default `https://bsky.social`), identifier and password; two-factor authentication is not supported | none |
| Mastodon | Server env `MASTODON_URL`, `MASTODON_CLIENT_ID`, `MASTODON_CLIENT_SECRET`; OAuth. `mastodon-custom` is the variant for another instance | none |
| LinkedIn (profile) | Server env `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`; OAuth (the company page is the separate `linkedin-page` channel) | none |
| Reddit | Server env `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`; OAuth | subreddit (`r/name`); flair id only if the subreddit requires one |
| Pinterest | Server env `PINTEREST_CLIENT_ID`, `PINTEREST_CLIENT_SECRET`; OAuth | the board's numeric id |
| Telegram | Server env `TELEGRAM_TOKEN` (a bot), the bot added to the chat or channel | none |
| Discord | Server env `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN_ID`; the bot in the server | the channel's numeric id |
| Medium | The form asks for an API key (integration token) | none |
| Farcaster | Server env `NEYNAR_CLIENT_ID`, `NEYNAR_APP_FID` and the other `NEYNAR_*` values of the Postiz docs | optional channel id |
| Nostr | The form asks for the private key as a hex string. Use a throwaway key | none |
| Lemmy | The form asks for service (instance URL), identifier and password | the community's name and its numeric id |

Where a platform's developer app or API access needs approval first (several do; read its current terms), connect the channel later and use a manual account (created in `/admin/social/conturi`) meanwhile.

Postiz lists boards, channels and communities when you compose a post in its own UI; use that to read the ids once and paste them into the site's composer. Hashnode also needs a publication id and tag ids from Postiz (not in the composer yet); see amendment 04.

## Status table

| Platform | Account | Owner | Status |
| --- | --- | --- | --- |
| dev.to | throwaway | Track B | not yet connected |
| Hashnode | throwaway | Track B | not yet connected |
| X | — | Track B | blocked on developer account + billing |
| LinkedIn | — | Track B | blocked on Community Management API application |
| Facebook | — | Track B | blocked on business verification |
| Instagram | — | Track B | blocked on Facebook |
| Threads, Bluesky, Mastodon, LinkedIn (profile), Reddit, Pinterest, Telegram, Discord, Medium, Farcaster, Nostr, Lemmy | — | Track B | not yet connected (amendment 04) |

Fill this table in as each account is connected (PRD task B2).
