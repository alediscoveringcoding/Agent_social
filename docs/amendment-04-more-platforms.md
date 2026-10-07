# Amendment 04: more platforms (every Postiz provider)

| | |
| --- | --- |
| Status | Done locally; no platform is connected yet |
| Date | 2026-10-07 |
| Amends | [PRD](PRD.md) (sections 5, 6.2, 8.2, 10.5), [Amendment 03](amendment-03-finish-the-site.md) |
| Decision | Support every provider Postiz has, end to end (site, database, generator, worker, contract, fixtures, docs, tests), in two batches: twelve platforms first, then the other fifteen. All are automatic except YouTube, which needs video and is manual-only. |

## 1. Postiz version

The repository pins Postiz `v2.25.0` (`local/docker-compose.yml`). All 36 provider files of Postiz `main` already exist in that tag (`libraries/nestjs-libraries/src/integrations/social/`), with the same identifiers, so **no Postiz upgrade is needed**. Identifiers, text limits, settings DTOs and media rules below were read from that source on 2026-10-07; limits from platform documentation are named in the [PRD tables](PRD.md#platforms-added-by-amendment-04).

## 2. Platforms, modes and identifiers

**Aliases are not platforms.** Four Postiz identifiers map to a platform we already have: `instagram-standalone` is `instagram`, `mastodon-custom` is `mastodon`, `tiktok-business` is `tiktok`, `wrapcast` is `farcaster`. The 36 identifiers therefore give 33 platforms; with Substack and Product Hunt (no Postiz provider) the app has **35**.

| Platform (`platform` value) | Mode | Kind | Postiz `identifier` | Notes |
| --- | --- | --- | --- | --- |
| Threads (`threads`) | automatic | social | `threads` | 500 characters |
| Bluesky (`bluesky`) | automatic | social | `bluesky` | 300 graphemes, 3,000 bytes, 4 images |
| Mastodon (`mastodon`) | automatic | social | `mastodon`, `mastodon-custom` | 500 characters, a link counts 23 |
| LinkedIn profile (`linkedin`) | automatic | social | `linkedin` | separate from `linkedin-page`; labels are "LinkedIn (profil)" and "LinkedIn (pagina)" |
| Reddit (`reddit`) | automatic | social | `reddit` | subreddit and title (≤ 300) required |
| Pinterest (`pinterest`) | automatic | social | `pinterest` | board, title, link and an image required; 1000×1500 card format |
| Telegram (`telegram`) | automatic | social | `telegram` | 4,096 characters, 1,024 with an image |
| Discord (`discord`) | automatic | social | `discord` | channel id required |
| Medium (`medium`) | automatic | **article** | `medium` | title, subtitle, tags ≤ 3, canonical URL to our blog |
| Farcaster (`farcaster`) | automatic | social | `wrapcast` | 320 UTF-8 bytes |
| Nostr (`nostr`) | automatic | social | `nostr` | plain text |
| Lemmy (`lemmy`) | automatic | social | `lemmy` | community name and id, title 3–200 |
| Slack (`slack`) | automatic | social | `slack` | channel id required; 40,000 characters |
| WordPress (`wordpress`) | automatic | **article** | `wordpress` | markdown body is sent as HTML; title required |
| Listmonk (`listmonk`) | automatic | **article** (newsletter) | `listmonk` | title is the subject, subtitle the preview; list id required |
| VK (`vk`) | automatic | social | `vk` | 2,048 characters |
| Google Business (`gmb`) | automatic | social | `gmb` | 1,500 characters, one 4:3 image, optional button |
| Tumblr (`tumblr`) | automatic | social | `tumblr` | up to 30 images |
| Dribbble (`dribbble`) | automatic | social | `dribbble` | exactly one 400×300 or 800×600 image; 800×600 card format |
| MeWe (`mewe`) | automatic | social | `mewe` | profile or group |
| Skool (`skool`) | automatic | social | `skool` | group, category and title required |
| Whop (`whop`) | automatic | social | `whop` | company and forum ids required |
| Moltbook (`moltbook`) | automatic | social | `moltbook` | 300 characters, text only |
| Kick (`kick`) | automatic | social | `kick` | live chat message, 500 characters, text only |
| Twitch (`twitch`) | automatic | social | `twitch` | live chat message or announcement, text only |
| TikTok (`tiktok`) | automatic | social (photo post) | `tiktok`, `tiktok-business` | at least one image; private by default |
| YouTube (`youtube`) | **manual-only** | social (video) | `youtube` | **needs video** |
| Substack, Product Hunt | manual-only | article, launch | none | as before |

### Why YouTube is manual-only, and TikTok is not

- **YouTube**: the Postiz provider accepts exactly one media item and it must be a video (`checkValidity`: "Item must be a video"). This app makes text and images. The YouTube channel is added to the platform list so it **syncs and shows** in the accounts screen, but always as a manual account (the sync creates it that way, a trigger and a check forbid automatic mode, and the worker never receives its jobs). The generator drafts the title and the description; the handoff page carries a "needs video" notice, the title (≤ 100), the tags (≤ 500 characters in all) and the description to copy, and a checklist that starts with "the video is uploaded". Video upload is not built.
- **TikTok**: the Postiz provider publishes photo posts (several images, no video), so TikTok is automatic with images. Postiz converts PNG cards to JPEG for it. Images must be at most 1,080 px on the shorter side (all our card formats are), and a post needs at least one image. Visibility defaults to private (`SELF_ONLY`) because TikTok apps that have not passed an audit can only post privately; a person widens it in the composer. Duet, stitch, music and the like are fixed off.
- **Kick and Twitch** are live-chat messages: text only, 500 characters. **Moltbook** is text only.

### Other decisions

- **Nothing was left out of Postiz's provider list.** Platforms outside Postiz (Hacker News, Quora and the like) were not requested and are not added.
- **`linkedin` is now a real platform name.** It used to be the example of a wrong name for `linkedin-page` (a variant with an unknown platform is kept on the revision, without a destination). That test now uses `twitter`.
- **Counting is per platform**, in the pattern of X's weighted length: `site/src/lib/social/text-length.ts` (copied to `worker/src/generator/text-length.ts`) counts Bluesky graphemes, Mastodon links as 23, Farcaster bytes and everything else as code points. Telegram's limit drops to 1,024 when an image is attached, because the text becomes its caption.
- **The generator fills only what it can know**: text, and a title where a platform wants one (Reddit, Pinterest, Lemmy, Dribbble, Skool, TikTok, YouTube; optional for Tumblr and Whop), plus the Pinterest link. Subreddit, board, channel, community and similar ids are chosen by a person; approval waits for them. Each variant in the model's JSON schema has two required strings, `title` and `link`, empty elsewhere. The schema has 0 optional and 2 union-type parameters (Claude structured outputs allow 24 and 16) and no `maxLength` (Gemini).
- **Medium, WordPress and Listmonk are articles.** Medium takes at most three tags of at most 25 characters and a canonical URL to our blog; its API takes the title as metadata only, so the worker puts the title at the top of the body unless the body already starts with a heading, and it has no cover image through Postiz. WordPress and Listmonk have an HTML editor in Postiz, which keeps only `p`, `h1`–`h3`, `ul`, `li`, `strong`, `u` and `a`; the worker converts the markdown body to exactly those tags (`worker/src/delivery/markdown-html.ts`).
- **Card formats**: `pinterest` (1000×1500) and `dribbble` (800×600, the size Dribbble shots must have; Google Business uses it too, 4:3). All 8 formats × 3 templates × 3 brands (72 combinations) render. TikTok uses the portrait card (1080×1350).

## 3. Settings: neutral keys and what Postiz receives

The site stores neutral keys (PRD 10.5); `worker/src/delivery/postiz-payload.ts` maps them to the provider DTOs under `libraries/nestjs-libraries/src/dtos/posts/providers-settings/` of Postiz v2.25.0.

| Platform | Neutral keys | Sent to Postiz as `settings` |
| --- | --- | --- |
| threads, bluesky, mastodon, telegram, nostr, linkedin, linkedin-page, facebook, vk, kick | none | `{ __type }` |
| reddit | `subreddit`, `title`, `post_type`, `link_url`, `flair_id` | `subreddit: [{ value: { subreddit, title, type, url, is_flair_required, flair? } }]` |
| pinterest | `board`, `title`, `link` | `{ board, title, link }` |
| discord, slack | `channel` | `{ channel }` |
| farcaster | `channel` (optional) | `subreddit: [{ value: { id } }]` (Postiz reuses the Reddit field name) or `[]` |
| lemmy | `community`, `community_id`, `title`, `link` | `subreddit: [{ value: { subreddit, id, title, url? } }]` |
| medium | `title`, `subtitle`, `tags`, `canonical_url` | `{ title, subtitle, canonical, tags: [{ value, label }] }`, at most three tags |
| wordpress | `title`, `post_type`, `status` | `{ title, type, status, main_image? }` |
| listmonk | `title`, `subtitle`, `list`, `template` | `{ subject, preview, list, template? }` |
| gmb | `cta_type`, `cta_url` | `{ topicType: "STANDARD", callToActionType?, callToActionUrl? }` |
| tumblr | `title`, `link`, `source_url`, `tags` | `{ title?, link?, sourceUrl?, tags? }` (tags as one comma-separated string) |
| dribbble | `title`, `team` | `{ title, team? }` |
| mewe | `post_type`, `group` | `{ postType, group? }` |
| skool | `group`, `label`, `title` | `{ group, label, title }` |
| whop | `company`, `experience`, `title` | `{ company, experience, title? }` |
| moltbook | `submolt` | `{ submolt? }` |
| twitch | `message_type`, `announcement_color` | `{ messageType?, announcementColor? }` |
| tiktok | `title`, `privacy_level` | `{ title?, privacy_level, duet: false, stitch: false, comment: true, autoAddMusic: "no", brand_content_toggle: false, brand_organic_toggle: false, content_posting_method: "DIRECT_POST" }` |
| youtube | `title`, `tags` | never sent: manual handoff only |

### Corrections to the existing Postiz calls

Reading the Postiz source showed that the worker's Postiz requests did not match its API (the checklist in `docs/postiz-notes.md` was still open). They are fixed because the new settings cannot work without them, and each is covered by a test:

- The create-post body is Postiz's `CreatePostDto`: `integration: { id }`, `value: [{ content, image: [...] }]`, `date`, `shortLink`, `tags`. It was `integration: "<id>"`, `content` and `media`.
- The answer is a list of `{ postId, integration }`; the worker read `id` and `posts[0].id`, and still accepts them.
- `GET /integrations` names the provider `identifier`. The sync read `providerIdentifier`, which that endpoint does not return, so every channel would have been ignored. It now reads `identifier` first.
- `GET /posts` requires `startDate` and `endDate` and answers `{ posts }`, with the channel as `integration: { id }`.
- X: Postiz calls the reply setting `who_can_reply_post`; the neutral key `who_can_reply` is mapped.
- dev.to and Hashnode: `canonical_url` is sent as `canonical`, and tags as `{ value, label }`.
- A platform that must not be sent (Substack, Product Hunt, YouTube) that reaches the worker fails with `VALIDATION_REJECTED`.

## 4. What changed

- **Site**: `constants.ts` (platforms, labels, kinds, manual-only list and reasons, card formats, provider map, editor URLs), `validation.ts` (limits, required fields, counting), `text-length.ts`, `platform-settings.ts` (one table for editor fields, preview lines and handoff fields), `draft-edit.ts`, `draft-mapping.ts`, `handoff.ts` (fields, checklists, the "needs video" notice), the draft editor, preview and manual handoff panel, the card layout, the sync route (manual-only channels sync as manual accounts), fixtures (`more-platforms`, `every-platform`, and Medium, WordPress and Listmonk on the article draft) and the fake Postiz channels.
- **Database**: `0008_more_platforms.sql` (one `social_known_platforms()` function behind the platform checks, the `pinterest` card format) and `0009_all_postiz_platforms.sql` (the remaining platforms, the `dribbble` card format, `social_manual_only_platforms()` with its check and a trigger that gives the existing "stay manual" error for YouTube). Earlier migrations are untouched.
- **Worker**: `platforms.ts`, `generator/schema.ts`, `prompts.ts`, `validators.ts`, `variant-settings.ts`, `loops/generator.ts`, `loops/sync.ts`, `loops/delivery.ts`, `delivery/postiz-payload.ts`, `delivery/markdown-html.ts`, `services/postiz-api.ts`; the mock site seeds Bluesky and Reddit jobs.
- **Contract**: the `Platform` enum, the per-platform settings table and the sync provider list in `docs/contracts/worker-api.openapi.yaml`.

## 5. Verification

- `cd site && npm run ci`: type check, lint, 341 tests, production build.
- `cd worker && npx --no-install tsc --noEmit && npm test`: 63 tests.
- New tests cover: limits and required fields per platform (site and worker); the generator schema listing every platform and staying inside the Claude limits; the worker's tables matching the site's (platforms, kinds, providers, limits, manual-only list) and the OpenAPI enum; all 36 Postiz identifiers mapped, aliases included; the Postiz settings of each platform; the markdown to HTML conversion; the Pinterest and Dribbble formats rendering for every template and brand; migrations 0008 and 0009 on PGlite; a Bluesky draft going through the fake generator, approval and the fake worker to published; a Reddit account in manual mode and a synced YouTube channel completing the manual handoff.
- No real AI or platform API was called.

## 6. What the owner still has to do

1. Connect each channel you want in Postiz and run an account sync (see [setup.md](setup.md) for the server variables each provider needs). Assign each synced channel to a brand and unpause it.
2. Read the ids once in Postiz's own composer and paste them in the site: Pinterest board id, Discord and Slack channel ids, Lemmy community name and id, Skool group and category, Whop company and forum, Listmonk list id, a Reddit flair id where required.
3. Confirm the create-post body and the per-provider settings against a running Postiz (task B3); they were taken from the source, not from a live instance.
4. **Hashnode is not finished**: Postiz needs a `publication` id and tag ids from its own list (`hashnode.tags.ts`), which the composer does not have. This was already the case before this amendment. WordPress category and tag ids and Google Business event and offer fields are not exposed either.
5. Values marked "flagged" in the PRD table (the Threads carousel size and topic tag, the Discord ten-file limit, LinkedIn's nine images) come from commonly documented limits that could not be re-read on 2026-10-07. Check them when connecting those channels.
6. YouTube: videos are uploaded by hand; the site only hands over the title, tags and description.
7. Dribbble: in Postiz v2.25.0 the provider's token refresh calls Pinterest's token endpoint (copied code), so a Dribbble channel will probably need reconnecting when its token expires. Skool connects through the Postiz browser extension, not OAuth.
8. **Medium**: Medium stopped issuing integration tokens on 2025-01-01 and accepts no new API integrations; tokens created before then still work. The Postiz Medium channel needs such a token. Without one, create the Medium account in manual mode (see [visibility-channels.md](visibility-channels.md)).
