# Direct TypeScript publishing

The native app runs the Next.js site, embedded PGlite and the TypeScript worker
in WSL. It requires no Postiz process, Docker, Compose, Redis or Temporal. The
implementation is independent; Postiz source code is not included.

Automatic connections: Instagram, Facebook Pages, X, LinkedIn profiles and
Pages, Bluesky, Telegram, dev.to, TikTok, YouTube, Hashnode, Slack, GitHub,
Listmonk, Stack Exchange, Farcaster and Lemmy. Medium is available only with
an existing integration token that still works; its API is unsupported upstream.
See [amendment 09](amendment-09-api-connections.md) for formats, access and the
separate inactive-platform bin. WordPress, Discord and
Mastodon are excluded at the owner's request. Historical accounts and their
approved revisions remain intact; reconnect an account directly to use the new
publishing path. Old Postiz identifiers are never reused as native identifiers.

## Start

From PowerShell in the repository:

```powershell
wsl.exe -e bash /mnt/r/Repos/Agent_social/scripts/dev-local.sh
```

Open `http://localhost:3000/admin/social/conturi`. Sign in with the application's
admin account and TOTP. This login is separate from social platform accounts.
Use Ctrl+C in the startup terminal to stop the site and worker.
Inside WSL, `npm run dev:up` starts the same native runtime and
`npm run dev:down` stops this checkout's recorded site/worker process. `npm run
health` checks the site and worker; legacy container checks are opt-in.

Run npm and Node exclusively in Linux/WSL. On a fresh machine use the existing
`scripts/update.sh --no-pull --admin-email admin@example.com` setup command.
The site automatically applies migrations when it opens the local database;
stop other site processes first. Back up private data before migrating.

## Connect existing social accounts

In **Conturi**, choose a brand and use one of the connection forms:

| Platform | Connection |
| --- | --- |
| Bluesky | Existing handle/email and an app password from account settings |
| dev.to | API key from Settings > Extensions |
| Telegram | BotFather token and existing chat/channel ID; grant the bot posting permission |
| Instagram | Authorize a Business or Creator account with Instagram Login |
| Facebook | Authorize, then select an existing Page with content publishing permission |
| X | Authorize the existing account with OAuth 2.0 and PKCE |
| LinkedIn | Authorize a profile, or select an administered company Page |
| TikTok | Authorize, then review current creator/privacy options in the composer |
| YouTube | Authorize the Google account and select its YouTube channel |
| Medium | Existing integration token; no new OAuth integration or password login |
| Hashnode | Personal token and publication ID; active Pro plan and publishing role |
| Slack | Installed app token and verified channel ID |
| GitHub | Repository token and owner/name; releases or discussions |
| Listmonk | HTTPS instance, API user/token, sender email and list ID |
| Stack Exchange | Stack Apps key, write_access token and site |
| Farcaster | Neynar API key and approved signer UUID |
| Lemmy | Existing login, optional TOTP, instance and community ID; only session stored |

New accounts start paused. Check the brand, daily limit and publishing mode,
then unpause deliberately. Reconnecting the same native identity updates its
encrypted credentials without creating a duplicate or changing its brand/pause.
Connecting creates no remote posts.

The accounts screen puts OAuth/API connections first. Other platforms appear
under **Alte platforme — publicare API neactiva**, with their actual blocker.
Missing application code is labelled separately from unverified API access.
Manual account creation is an optional collapsed advanced section.

Medium and Hashnode upload attached images to platform storage. GitHub,
Stack Exchange, Farcaster and Lemmy currently support text/links without attached
media; validation blocks unsupported attachments before approval. Listmonk sends
HTML campaigns with a plain text alternative and waits for the existing campaign
to finish.

## Developer application setup

Configure only the services you use in private `site/.env.local`, using the
placeholders in `site/.env.example`. Social network passwords are entered on
the platform's authorization page. OAuth still requires a registered developer
application and the relevant provider permissions/access.

| Provider | Server settings |
| --- | --- |
| Facebook Pages | `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET`, `META_GRAPH_VERSION` |
| Instagram Login | `INSTAGRAM_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET`, `META_GRAPH_VERSION` |
| X | `X_CLIENT_ID`, `X_CLIENT_SECRET` |
| LinkedIn | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_API_VERSION` |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` |
| YouTube | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |

Register the exact callback `<site-origin>/api/native/callback`. Set
`PUBLIC_SITE_BASE_URL` to the app's public HTTPS origin when required by the
provider, and access the app at that same origin so the admin session and OAuth
browser binding are available on return. A public HTTPS URL is also required
when Instagram, TikTok photos or article covers fetch media from this app.
TikTok requires verification of its photo source domain. Multipart providers
can transfer files without a public media URL.

Select a supported Meta Graph version in the developer dashboard and set
`META_GRAPH_VERSION` explicitly. LinkedIn defaults to version `202610`; update
it deliberately when the provider retires a version. X API access/billing,
Meta permissions/review, Google OAuth verification and TikTok access/audit
requirements are configured in their respective developer consoles.

Set `NATIVE_CREDENTIALS_KEY` to 32 random bytes encoded as 64 hex characters.
Local mode can derive an independent encryption key from `LOCAL_AUTH_SECRET`
when it is blank. Preserve the encryption key when restoring data or changing
the session secret; previous explicit keys can be listed temporarily in
`NATIVE_CREDENTIALS_PREVIOUS_KEYS`. Never commit real environment files.

## Content, videos and publishing

Drafts, image cards, exact-content approval, scheduling, daily caps, account
pause, source verification and manual handoffs use the existing app. Edits
create a new revision and revoke its approval.

Upload images or MP4 H.264 videos from **Media**. Images are limited to 8 MB,
videos to 128 MB. Video dimensions/duration are parsed in TypeScript; MP4 user
metadata is stripped without re-encoding the media. Attach the video to the
draft before approval. YouTube requires one video and explicit visibility,
children's audience and synthetic-media selections. TikTok requires explicit
publishing consent, commercial-content and synthetic-media selections, and a
privacy choice allowed by the current creator account.

The current native video path supports YouTube, TikTok, Instagram Reels and
Telegram. Native X, LinkedIn and Facebook adapters currently publish text and
images. Other video formats, native post sequences and the wider feature
inventory in amendment 08 remain separate work; this is not a claim of full
Postiz feature parity.

Instagram receives a deterministic JPEG transport copy of an approved image
when necessary. The source bytes, attached copy, card specification and approval
hash stay unchanged. Native media is read from private storage and its SHA-256
is checked again before publication.

Publishing remains disabled by default. Offline validation uses
`WORKER_DRY_RUN=true`, fake generation and fake provider clients. To deliberately
enable real approved deliveries, set `SOCIAL_PUBLISHING_ENABLED=true` on the site
and `WORKER_DRY_RUN=false` on the worker. Postiz was removed in amendment 10: old `POSTIZ_*` settings left in
`worker/.env` are ignored, and an account first registered through Postiz must be
connected directly before it publishes.
Historical polls and reconciliation also stay on hold until compatibility is
enabled; a skipped lookup never marks a potentially published post as absent.

If a remote response is lost, the app keeps a durable reconciliation record.
YouTube resumable capabilities are encrypted, and processing is polled by ID.
The app never guesses absence from elapsed time. On the post page an admin can
record a found URL, or confirm absence after 30 minutes and then use the existing
failed-destination retry. This action is audited and invalidates the old attempt.

## Validation and references

Run the site and worker checks separately on small WSL machines:

```bash
cd site && npm run ci
cd ../worker && npx --no-install tsc --noEmit && npm test
```

Tests use temporary databases and injected clients; they never call real AI,
platform publishing, account authorization or notification services. Live access
and provider review cannot be established by offline tests.

Verified in WSL on 2026-10-22: site CI (type check, lint, 564 tests and production
build), worker type check and 235 tests. Launcher syntax/help and backup of
temporary fixtures passed. The existing local database was not used for checks.

Stop the app before `npm run backup`. The default backup copies PGlite, private
media and the private environment files into `~/agent-social-backups` with
restricted permissions. Restore the database directory together with its original
encryption/session keys. The backup never invokes Docker.

Official API references: [Meta Pages](https://developers.facebook.com/docs/pages-api/posts),
[Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login),
[X](https://docs.x.com/x-api/posts/create-post),
[LinkedIn](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api),
[TikTok](https://developers.tiktok.com/docs/en/content-posting-api-get-started),
[YouTube](https://developers.google.com/youtube/data/guides/using_resumable_upload_protocol),
[Bluesky](https://github.com/bluesky-social/atproto/tree/main/lexicons),
[Telegram](https://core.telegram.org/bots/api),
[dev.to](https://developers.forem.com/api/v1).
