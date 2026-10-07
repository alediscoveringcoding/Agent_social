# Amendment 04: more platforms

| | |
| --- | --- |
| Status | Done locally; no platform is connected yet |
| Date | 2026-10-07 |
| Amends | [PRD](PRD.md) (sections 5, 6.2, 8.2, 10.5), [Amendment 03](amendment-03-finish-the-site.md) |
| Decision | Add twelve platforms end to end (site, database, generator, worker, contract, fixtures, docs, tests). All twelve have a Postiz provider, so all are automatic. No video platform is added. |

## 1. Platforms and modes

The provider identifiers, text limits and settings below were read from the Postiz `v2.25.0` source (the version pinned in `local/docker-compose.yml`) on 2026-10-07. Limits, counting rules and sources per platform are in the [PRD table](PRD.md#platforms-added-by-amendment-04).

| Platform (`platform` value) | Mode | Kind | Postiz `identifier` | Notes |
| --- | --- | --- | --- | --- |
| Threads (`threads`) | automatic | social | `threads` | 500 characters |
| Bluesky (`bluesky`) | automatic | social | `bluesky` | 300 graphemes, 3,000 bytes, 4 images |
| Mastodon (`mastodon`) | automatic | social | `mastodon` (also `mastodon-custom`) | 500 characters, a link counts 23 |
| LinkedIn profile (`linkedin`) | automatic | social | `linkedin` | separate from `linkedin-page`; labels are now "LinkedIn (profil)" and "LinkedIn (pagina)" |
| Reddit (`reddit`) | automatic | social | `reddit` | subreddit and title (≤ 300) required |
| Pinterest (`pinterest`) | automatic | social | `pinterest` | board, title, link and an image required; new 1000×1500 card format |
| Telegram (`telegram`) | automatic | social | `telegram` | 4,096 characters, 1,024 with an image |
| Discord (`discord`) | automatic | social | `discord` | channel id required |
| Medium (`medium`) | automatic | **article** | `medium` | title, subtitle, tags ≤ 3, canonical URL to our blog |
| Farcaster (`farcaster`) | automatic | social | `wrapcast` | 320 UTF-8 bytes |
| Nostr (`nostr`) | automatic | social | `nostr` | plain text |
| Lemmy (`lemmy`) | automatic | social | `lemmy` | community name and id, title 3–200 |

**No new platform is manual-only.** Substack and Product Hunt remain the only platforms whose account must be manual (the 0001 constraint and the 0005 account rules are unchanged). Any account, including a new platform's, can be switched to manual mode in `/admin/social/conturi` while its developer app or platform approval is pending; the manual handoff then shows the platform's own fields (subreddit, board, community, title, link) and a checklist for it.

### Left out, and why

- **TikTok and YouTube**: video platforms. This app makes text and images only.
- Other Postiz providers (Slack, Twitch, Kick, Tumblr, Dribbble, WordPress, Listmonk, Skool, MeWe, VK, Whop, Google Business, Moltbook): not in the request. A channel on any provider the site does not know is ignored at sync and listed in the answer, as before.
- Platforms with no publishing API that are not in the request (Hacker News, Quora, and the like): not added.

### Decisions worth knowing

- **`linkedin` is now a real platform name.** It used to be the example of a wrong name for `linkedin-page` (a variant with an unknown platform is kept on the revision, without a destination). The test for that case now uses `twitter`.
- **Counting is per platform**, in the pattern of X's weighted length: `site/src/lib/social/text-length.ts` (copied to `worker/src/generator/text-length.ts`) counts Bluesky graphemes, Mastodon links as 23, Farcaster bytes and everything else as code points. Telegram's limit drops to 1,024 when an image is attached, because the text becomes its caption.
- **The generator fills only what it can know**: text, and a title for Reddit, Pinterest and Lemmy (plus the Pinterest link, defaulting to the source article). Subreddit, board, channel and community are chosen by a person; approval is blocked until they are set. Each variant in the model's JSON schema gets two required strings, `title` and `link`, empty for the other platforms. The schema has 0 optional parameters and 2 union-type parameters (limits for Claude structured outputs: 24 and 16), and no `maxLength` (Gemini).
- **Medium is an article**: it takes `article.title`, `subtitle`, `body_markdown`, at most three tags of at most 25 characters (the Medium API ignores the rest), and a canonical URL to our blog, like dev.to and Hashnode. Medium's API takes the title as metadata only, so the worker puts the title at the top of the body as a heading unless the body already starts with one. Postiz's own form requires a subtitle, so validation does too, although Medium shows none. Medium gets no cover image through Postiz; an attached image only produces a warning.
- **Card format**: `pinterest`, 1000×1500, stacked like the portrait card. All 7 formats × 3 templates × 3 brands (63 combinations) render. Other formats per platform are listed in PRD 10.5.

## 2. Settings: neutral keys and what Postiz receives

The site stores neutral keys (PRD 10.5); `worker/src/delivery/postiz-payload.ts` maps them to the provider DTOs under `libraries/nestjs-libraries/src/dtos/posts/providers-settings/` of Postiz v2.25.0.

| Platform | Neutral keys | Sent to Postiz as `settings` |
| --- | --- | --- |
| threads, bluesky, mastodon, telegram, nostr, linkedin, linkedin-page, facebook | none | `{ __type }` |
| reddit | `subreddit`, `title`, `post_type`, `link_url`, `flair_id` | `subreddit: [{ value: { subreddit, title, type, url, is_flair_required, flair? } }]` |
| pinterest | `board`, `title`, `link` | `{ board, title, link }`; the text is the pin description, the images are the pin |
| discord | `channel` | `{ channel }` |
| farcaster | `channel` (optional) | `subreddit: [{ value: { id } }]` (Postiz reuses the Reddit field name) or `[]` |
| lemmy | `community`, `community_id`, `title`, `link` | `subreddit: [{ value: { subreddit, id, title, url? } }]` |
| medium | `title`, `subtitle`, `tags`, `canonical_url` | `{ title, subtitle, canonical, tags: [{ value, label }] }`, at most three tags |

### Corrections to the existing Postiz calls

Reading the Postiz source showed that the worker's Postiz requests did not match its API (the checklist in `docs/postiz-notes.md` was still open). They are fixed here because the new settings cannot work without them, and each is covered by a test:

- The create-post body is Postiz's `CreatePostDto`: `integration: { id }`, `value: [{ content, image: [...] }]`, `date`, `shortLink`, `tags`. It was `integration: "<id>"`, `content` and `media`.
- The answer is a list of `{ postId, integration }`; the worker read `id` and `posts[0].id`, and still accepts them.
- `GET /integrations` names the provider `identifier`. The sync read `providerIdentifier`, which that endpoint does not return, so every channel would have been ignored. It now reads `identifier` first.
- `GET /posts` requires `startDate` and `endDate` and answers `{ posts }`, with the channel as `integration: { id }`.
- X: Postiz calls the reply setting `who_can_reply_post`; the neutral key `who_can_reply` is mapped.
- dev.to and Hashnode: `canonical_url` is sent as `canonical`, and tags as `{ value, label }`.
- A platform with no Postiz provider (Substack, Product Hunt) that reaches the worker fails with `VALIDATION_REJECTED` instead of being sent.

## 3. What changed

- **Site**: `constants.ts` (platforms, labels, kinds, card formats, provider map, editor URLs), `validation.ts` (limits, required fields, counting), `text-length.ts`, `platform-settings.ts` (one table for editor fields, preview lines and handoff fields), `draft-edit.ts`, `draft-mapping.ts`, `handoff.ts` (fields and checklists), the draft editor and preview, the card layout, fixtures (a `more-platforms` draft with 11 platforms, and Medium on the article draft), and the fake Postiz channels.
- **Database**: `site/supabase/migrations/0008_more_platforms.sql`: one `social_known_platforms()` function behind the platform checks of `social_accounts` and `social_destinations`, the `pinterest` card format on `social_media`, and `social_admin_create_account` taking its platform list from the function. Earlier migrations are untouched.
- **Worker**: `platforms.ts`, `generator/schema.ts`, `prompts.ts`, `validators.ts`, `variant-settings.ts`, `loops/generator.ts`, `loops/sync.ts`, `loops/delivery.ts`, `delivery/postiz-payload.ts`, `services/postiz-api.ts`; the mock site seeds a Bluesky and a Reddit job.
- **Contract**: the `Platform` enum, the per-platform settings table and the sync provider list in `docs/contracts/worker-api.openapi.yaml`.

## 4. Verification

- `cd site && npm run ci`: type check, lint, 315 tests, production build.
- `cd worker && npx --no-install tsc --noEmit && npm test`: 51 tests.
- New tests cover: limits and required fields per platform (site and worker); the generator schema listing every platform and staying inside the Claude limits; the worker's tables matching the site's; every new Postiz identifier mapped by the sync; the Postiz settings of each platform; the Pinterest format rendering for every template and brand; migration 0008 on PGlite; a Bluesky draft going through the fake generator, approval and the fake worker to published; a Reddit account in manual mode completing the manual handoff.
- No real AI or platform API was called.

## 5. What the owner still has to do

1. Connect each new channel in Postiz and run an account sync (see [setup.md](setup.md) for the server variables each provider needs). Assign each synced channel to a brand and unpause it.
2. Read the ids once in Postiz's own composer and paste them in the site: Pinterest board id, Discord channel id, Lemmy community name and id, a Reddit flair id where the subreddit requires one.
3. Confirm the create-post body and the per-provider settings against a running Postiz (task B3); they were taken from the source, not from a live instance.
4. **Hashnode is not finished**: Postiz needs a `publication` id and tag ids from its own list (`hashnode.tags.ts`), which the composer does not have. This was already the case before this amendment.
5. Values marked "flagged" in the PRD table (the Threads carousel size and topic tag, the Discord ten-file limit, LinkedIn's nine images) come from commonly documented limits that could not be re-read on 2026-10-07. Check them when connecting those channels.
