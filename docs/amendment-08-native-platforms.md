# Amendment 08: native TypeScript social publishing

Status: implementation in progress. This document is the scope and cutover record,
not a claim that the replacement is complete.

Owner's current platform scope: Instagram, Facebook Pages, X, LinkedIn profiles
and Pages, Bluesky, Telegram, dev.to, TikTok and YouTube. WordPress, Discord and
Mastodon are explicitly excluded. Other platform rows below remain an inventory
of the original parity request, rather than a claim that their adapters exist.

## Decision

Replace the Postiz service with an independent implementation inside this
repository. Do not import or adapt Postiz source code. Use official platform API
documentation and independently written adapters.

The application and background job logic are TypeScript running on Node in WSL.
Keep the existing embedded PGlite database and private storage. No Docker,
Compose, Redis, Temporal, or separate PostgreSQL server is required by the native
runtime. Embedded libraries and their native or WASM dependencies remain allowed.

This changes PRD D1 and the Postiz-specific parts of F1, F6, F7 and flow 6.3.
The existing admin authentication, approval, immutable revision, media hash,
activity, daily cap, pause, and publishing kill-switch requirements still apply.

## Ownership and runtime

The Next.js server remains the sole owner of the local database. Server routes
and actions own credentials, OAuth callbacks, provider requests and activity.
The existing TypeScript worker claims durable jobs through authenticated HTTP;
it never opens the site's database files. The native scheduler persists work,
leases, rate budgets and retry times in SQL, rather than relying on timers alone.

The local startup command remains `bash scripts/dev-local.sh`. No container
startup command belongs in that path. Optional historical Postiz data is retained
until an explicit migration and verification have succeeded.

## Feature inventory

The baseline is the complete self-hosted Postiz feature set, initially bounded by
the version previously pinned in this repository, v2.25.0. The public feature
inventory below must be checked against that baseline before claiming parity.
Managed cloud hosting is a deployment service, not a local runtime dependency.

| Capability | Existing local application | Native work |
| --- | --- | --- |
| Admin login, allowlist and TOTP | Implemented | Preserve every action's checks |
| OAuth and credential-based account connections | External Postiz dependency | Add in-app connection and account selection |
| Token encryption, refresh, reconnect and revocation | External Postiz dependency | Add server-owned encrypted credentials and atomic refresh |
| Profiles, Pages, boards, channels and communities | Destination settings exist | Discover and verify selectable remote destinations |
| Account brands, pause, modes and daily caps | Implemented | Remove Postiz-specific eligibility checks |
| Per-platform composer and validation | Implemented for 44 platforms | Preserve rules; add native capabilities |
| Article and launch composers | Implemented | Preserve native and manual destinations |
| Media library, image uploads, alt text and previews | Implemented | Use provider-specific native uploads |
| Brand cards and templates | Implemented | Preserve immutable card copies |
| Video, Reels and video destinations | Not implemented | Add ingest, metadata, previews, upload and processing states |
| Threads, first comments, mentions and delayed comments | Partial text support | Add structured, approved sequences |
| Saved sets, templates and signatures | Not implemented | Add reusable content settings |
| Calendar, scheduling and time slots | Implemented | Keep the database as the only schedule |
| Recurring and recycled content | Not implemented | Create new revisions subject to the existing approval rules |
| Approval, cancellation and rescheduling | Implemented | Preserve exact-content approval and atomic SQL transitions |
| Publishing, polling, retries and reconciliation | Implemented through Postiz | Replace transport; prevent duplicate remote side effects |
| Rate limits and provider budgets | Daily cap and retry support | Add durable per-provider and per-account budgets |
| Manual handoffs and publication confirmation | Implemented | Preserve for channels without a usable publishing API |
| Remote analytics collection | Not implemented | Add capability-aware collectors and snapshots |
| Analytics views and exports | Not implemented | Add reports with explicit unavailable metrics |
| Image editing | Card editor exists | Add crop, resize and reusable image operations |
| AI drafting and research | Implemented | Preserve injected clients, sources and approval requirements |
| AI image generation | Not implemented | Add configurable provider clients and offline fakes |
| AI video generation and clipping | Not implemented | Add asynchronous provider jobs and media review |
| Agent and copilot actions | Generation requests exist | Add scoped tools which cannot bypass approval |
| RSS ingestion | External n8n workflows | Add a native durable polling scheduler |
| Internal and global automation rules | Partial automation API | Add rules, triggers, actions and run history |
| Public API, webhooks and scoped authentication | Worker and automation APIs exist | Extend without exposing approval or platform secrets |
| MCP and CLI integrations | Not implemented | Add scoped local and remote agent surfaces |
| Client groups and connection invitations | Brands exist | Add expiring invitations and verified destination selection |
| Team roles and collaboration | Allowlisted admins exist | Add roles, comments and assignment while preserving TOTP |
| Notifications | Event feed and external email workflow | Add native email delivery and preferences |
| Link shorteners | Not implemented | Add optional provider adapters and safe link handling |
| Import, export, backup and restore | Local backup helper exists | Remove container dependency; preserve private storage |
| Operations, activity and worker health | Implemented | Add native connection, queue and provider diagnostics |
| Optional commercial modules present upstream | Not implemented | Audit baseline source/features; keep external services opt-in |

References: [Postiz feature overview](https://github.com/gitroomhq/postiz-app),
[documentation index](https://docs.postiz.com/llms.txt). These are product
references, not source code to copy.

## Platform inventory

Every existing platform remains accounted for. A manual channel is not presented
as an implemented automatic adapter. YouTube moves into the automatic-capability
inventory when native video is implemented; existing manual YouTube accounts and
their historical approvals remain intact.

| Platform | Native connection family | Initial adapter status |
| --- | --- | --- |
| Facebook Pages | OAuth | Implemented; offline verified |
| Instagram | Standalone Instagram Login OAuth | Implemented; offline verified |
| LinkedIn Pages | OAuth | Implemented; offline verified |
| X | OAuth | Implemented; offline verified |
| dev.to | API key | Implemented; offline verified |
| Hashnode | API token and publication | Pending |
| Substack | Manual handoff | Preserve |
| Product Hunt | Manual handoff | Preserve |
| Threads | OAuth | Pending |
| Bluesky | App password | Implemented; offline verified |
| Mastodon | Instance-specific OAuth | Excluded by owner |
| LinkedIn profiles | OAuth | Implemented; offline verified |
| Reddit | OAuth and subreddit | Pending |
| Pinterest | OAuth and board | Pending |
| Telegram | Bot token and chat/channel | Implemented; offline verified |
| Discord | Bot/application authorization and channel | Excluded by owner |
| Medium | Existing integration token | Pending |
| Farcaster | Signer authorization | Pending |
| Nostr | Signing key and relays | Pending |
| Lemmy | Instance authentication and community | Pending |
| Slack | OAuth and channel | Pending |
| WordPress | Application password and site | Excluded by owner |
| Listmonk | Instance API credentials and list | Pending |
| VK | OAuth | Pending |
| Google Business Profile | OAuth and location | Pending |
| Tumblr | OAuth and blog | Pending |
| Dribbble | OAuth | Pending |
| MeWe | Provider-specific account authorization | Pending |
| Skool | Browser-extension connection | Pending |
| Whop | OAuth and company/experience | Pending |
| Moltbook | Provider-specific account authorization | Pending |
| Kick | OAuth and channel | Pending |
| Twitch | OAuth and channel | Pending |
| TikTok | OAuth and direct content posting | Implemented; offline verified |
| YouTube | OAuth and channel, with native video | Implemented; offline verified |
| Quora | Manual handoff | Preserve |
| LinkedIn articles | Manual handoff | Preserve |
| TradingView | Manual handoff | Preserve |
| Investing.com | Manual handoff | Preserve |
| Indie Hackers | Manual handoff | Preserve |
| Stack Exchange | Manual handoff | Preserve |
| GitHub | Existing manual workflow | Preserve |
| Forum | Manual handoff | Preserve |
| Press | Manual handoff | Preserve |

## Connection and publishing invariants

1. Every connection action and callback verifies an allowlisted, TOTP-verified
   admin. OAuth state is expiring, single-use, tied to the initiating admin and
   browser, and uses PKCE wherever supported.
2. Encrypt tokens and application passwords at rest. Return connection metadata
   to the browser, never saved secrets. Do not log secrets or provider responses
   that can contain credentials.
3. Store native provider identifiers separately from historical Postiz identifiers.
   Never rewrite approved revisions, media copies or immutable hash vectors.
4. Keep the current worker API contract compatible. Introduce additive or versioned
   native endpoints rather than silently changing the meaning of existing fields.
5. Before a remote write, recheck the approved destination, lease, attempt,
   account, pause and kill switch. Persist the attempt before making the request.
6. An ambiguous remote write stays in reconciliation. A provider without a reliable
   lookup or idempotency mechanism requires human resolution, not a speculative
   retry that can publish twice.
7. Token refresh and job ownership use SQL compare-and-swap transitions. Every
   mutation records activity, including worker-originated credential changes.
8. Platform API access, credentials, billing and provider review requirements still
   apply to existing social accounts. Connection screens explain missing setup.

## Delivery sequence and completion checks

1. Native contracts, storage, encryption, OAuth state and capability inventory.
2. In-app credential/OAuth connection flows and destination discovery.
3. Independently written adapters for all 33 upstream platform families and their
   connection variants, plus the existing manual channels.
4. Native delivery, uploads, retries, reconciliation, rate budgets and refresh.
5. Video, post sequences, templates, recurrence, analytics and reporting.
6. Collaboration, invitations, notifications, automation, RSS, webhooks and agents.
7. Import/export, startup, backup/restore, documentation and full cutover.

For each completed capability, add meaningful fake-client coverage and record
implementation paths here. Run site CI and worker type checks/tests in WSL,
staggering heavy runs. Use temporary databases only. Routine validation does not
call real AI, connect real platform accounts, send emails or publish real content.

The replacement is complete only when the inventory has implementation and test
evidence, local startup requires no containers, all existing checks pass, and
unimplemented or externally unavailable operations are identified accurately.

## Current implementation evidence

Native code and fake-client tests: `site/src/lib/native/`. Connection forms and
destination selection: `site/src/app/admin/social/conturi/`. Native worker route:
`site/src/app/api/worker/social/v1/deliveries/[id]/native/route.ts`. Worker routing:
`worker/src/loops/delivery.ts`; its new path receives no platform credentials.
Migrations `0014` through `0020` add encrypted connections, OAuth, refresh leases,
publication fencing, processing checkpoints, native video, audited resolution and
worker capability negotiation to keep older workers away from native jobs.
MP4 ingest: `site/src/lib/social/media/video.ts`. Setup and current limitations:
[native-publishing.md](native-publishing.md).

Fifty-one native tests cover the requested adapters, OAuth primitives and admin
guards, encryption, SQL transitions, video validation, uncertain-write holds and
encrypted upload recovery. All calls are injected; live account connection,
publishing access and provider review have not been verified.

Integration validation on 2026-10-22 in WSL: `cd site && npm run ci` passed
type checking, lint, all 564 tests and the production build. Worker type checking
and all 235 tests passed, including disabled historical lookup coverage. Launcher
syntax/help and a container-free backup of temporary fixtures also passed.
The owner's database was not used for validation. These checks verify the native
core, not completion of the wider feature inventory above.
