# Amendment 09: automatic API accounts and an inactive-platform bin

The owner clarified that automatic publishing is the goal. Manual account
creation must not be the main connection workflow. Implement usable direct API
paths now and keep the other destinations in a separate, clearly labelled group.
WordPress, Discord and Mastodon remain excluded.

## Account screen

The primary forms connect existing accounts through OAuth or API credentials.
Connected accounts publish through the existing approval, scheduling and native
worker pipeline. Every new connection starts paused. The advanced manual form
remains collapsed for operators who explicitly choose that workflow; old manual
accounts and approved revisions retain their history.

`site/src/lib/native/capabilities.ts` is the public capability inventory. Its
automatic choices are tested against the actual provider registry. The inactive
bin accounts for every remaining platform and distinguishes a missing direct
connector from an integration whose availability/access still needs verification.
It does not claim that an unimplemented connector means the platform has no API.

## Automatic API connections

The original native batch remains: Instagram, Facebook Pages, X, LinkedIn profiles
and Pages, Bluesky, Telegram, dev.to, TikTok and YouTube.

| Added connection | Credentials/access | Implemented publication |
| --- | --- | --- |
| Medium | Existing integration token that still works; legacy API is unsupported | Articles with PNG/JPEG uploads, title, subtitle, tags and canonical URL |
| Hashnode | Personal token, publication ID, active Pro plan and publishing role | Articles with current GraphQL schema and persistent CDN cover upload |
| Slack | Installed app token with channel access and chat/files scopes | Text messages or staged image uploads with one final channel share |
| GitHub | Repository-scoped token with Contents/Discussions write access | Text releases or discussions in the verified repository/category |
| Listmonk | HTTPS instance, API user/token, sender email and list ID | HTML newsletter campaigns with plain text alternative; checkpoint before starting, poll until finished |
| Stack Exchange | Stack Apps key and OAuth token with write_access | Text questions or answers on the connected site |
| Farcaster | Neynar API key and already-approved signer | Text casts with provider idempotency tied to the delivery job |
| Lemmy | Existing account, optional TOTP, HTTPS instance and community ID | Text/link posts through API v4 or a v3-only fallback |

These are 18 platform identifiers, including the separate LinkedIn destinations.
API access still depends on the platform and account. Offline tests cannot
establish whether a real credential, developer application or legacy API works.

Medium is explicitly conditional: its official documentation says the API is no
longer supported and new integrations are closed. An ordinary Medium password
does not establish API access. Hashnode's current API requires Pro for publishing;
the retired endpoint and old cover-image schema are not used.

GitHub, Stack Exchange, Farcaster and Lemmy currently accept text/links without
attached media. Approval validation explains this before a job can be created.
Private one-hour download URLs are not embedded as permanent article assets.
Manual destinations retain their existing media behavior.

## Separate inactive bin

Threads, Reddit, Pinterest, Nostr, VK, Google Business Profile, Tumblr, Dribbble,
Whop, Moltbook, Kick and Twitch still lack direct adapters in this application.
The UI says that implementation is missing rather than calling these manual-only
or claiming that no API exists.

Substack, Product Hunt, Quora, LinkedIn articles, TradingView, Investing.com,
Indie Hackers, MeWe and Skool need a verified integration/access path before they
can be enabled here. Forum and Presa require a specific website and its API.
These are 23 inactive identifiers; the three excluded platforms are not offered.

## Storage, authorization and delivery

Migration `0021` adds GitHub and Stack Exchange to the native connection inventory
and permits their native automatic accounts. Historical manual rows keep their
constraints. The server and SQL retain TOTP admin checks, encrypted credentials,
exact-content approval, leases, pause/caps, the kill switch and audited transitions.
An uncertain remote write is reconciled rather than blindly retried.

Listmonk saves its campaign ID before changing the campaign to running. An uncertain
start polls that same campaign; it never creates a second sending campaign merely
because a response was lost. Lemmy stores the session token, not the login password.

## Validation and sources

Focused adapter and SQL tests passed with 23 checks against injected clients and
temporary PGlite databases. Full integration check results are recorded after CI.
Real account connections, publishing, newsletters and AI are not invoked by checks.

Primary API documentation:

- [Medium legacy API](https://github.com/Medium/medium-api-docs)
- [Hashnode current schema](https://github.com/Hashnode/gql-skill/blob/main/skills/gql-api/references/schema.graphql)
- [Slack messages](https://docs.slack.dev/reference/methods/chat.postMessage/) and [file completion](https://docs.slack.dev/reference/methods/files.completeUploadExternal/)
- [GitHub releases](https://docs.github.com/en/rest/releases/releases#create-a-release) and [discussions](https://docs.github.com/en/graphql/reference/discussions)
- [Listmonk campaigns](https://listmonk.app/docs/apis/campaigns/)
- [Stack Exchange write API](https://api.stackexchange.com/docs/write)
- [Neynar cast API](https://docs.neynar.com/reference/publish-cast)
- [Lemmy API v4](https://join-lemmy.org/docs/contributors/09-api-v4.html)
