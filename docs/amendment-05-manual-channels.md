# Amendment 05: manual channels (a third batch of manual-only platforms)

| | |
| --- | --- |
| Status | Done locally; no account exists yet. Accounts are created by hand in `/admin/social/conturi` |
| Date | 2026-10-07 |
| Amends | [PRD](PRD.md) (sections 5, 6.2, 8.2, 10.5), [Amendment 04](amendment-04-more-platforms.md) |
| Decision | Add nine channels where we post content repeatedly and have no usable publishing API (or one we deliberately do not automate). All nine are **manual-only**: the site prepares the text, fields and checklist; a person publishes and pastes the link back. 35 + 9 = **44 platforms**. |

The owner gave a long list of Romanian and international sites to "cover for posts". Most are **one-time listings** (directories, review sites, registries). Those are out of scope here. The per-site API research for the whole list is in [visibility-channels.md](visibility-channels.md).

## 1. Platforms

| Platform (`platform` value) | Label | Kind | Settings (neutral keys) | Limits and sources |
| --- | --- | --- | --- | --- |
| `quora` | Quora | social | `target_url` (required): the question or Space URL | Body ≤ 20,000 (flagged: Quora documents no limit) |
| `linkedin-article` | LinkedIn (articol) | **article** | `title` (required, ≤ 100), `subtitle` | Body ≤ 110,000 (flagged: third-party references such as unilink.us and eden.so; LinkedIn does not publish it); one cover image |
| `tradingview` | TradingView | social | `symbol` (required, for example `BINANCE:BTCUSDT`), `title` (required, ≤ 100) | Body ≤ 10,000 and title ≤ 100 (both flagged: TradingView's help pages say a title and description are required but give no numbers) |
| `investing` | Investing.com | social | `instrument_url` (required) | Body ≤ 5,000 (flagged) |
| `indiehackers` | Indie Hackers | social | `title` (required, ≤ 150), `group` | Title ≤ 150 and body ≤ 20,000 (flagged; popular titles average about 51 characters) |
| `stackexchange` | Stack Exchange | social | `site` (default `money.stackexchange.com`), `post_type` (`answer`, default, or `question`), `question_url` (required for an answer), `title` (question, 15 to 150), `tags` (question, 1 to 5, each ≤ 35) | Title 15–150, body 30–30,000, at most 5 tags (Stack Exchange help center; the owner's brief) |
| `github` | GitHub | **article** | `repo` (`owner/name`, required), `post_type` (`release`, default, or `discussion`), `title` (required), `tag` (required for a release), `category` (required for a discussion) | Release body ≤ 125,000 (GitHub REST API documentation; the owner's brief) |
| `forum` | Forum | social | `thread_url` (reply) **or** `title` (new thread): exactly one | Body ≤ 20,000 (flagged: differs per forum) |
| `press` | Presa (comunicat) | **article** | `title` (required), `subtitle` (the lead) | Body ≤ 50,000 (flagged) |

"Flagged" is the PRD's word for a limit we could not confirm from a primary source: it is a sensible cap, not a platform rule, and each is one number in `PLATFORM_MAX_LENGTH` (site) and `LENGTH_LIMITS` (worker). Images: only LinkedIn (articol) caps them (one cover); the card is the default image, in the existing `x` format (`hashnode_cover` for LinkedIn articles and GitHub). No new card format.

### Forum and Presa: one account per forum or outlet

`forum` and `press` are generic. **Each account is one forum or outlet**, named by the account's `display_name` (Forum Softpedia, Rankia Romania, the Bancherul.ro forum; StartupCafe.ro, Wall-Street.ro, Ziarul Financiar, Profit.ro, Economica.net, Juridice.ro and others) and carrying its own `open_editor_url`: the forum's new-thread page, or the outlet's contact or submission page. Neither has a default editor URL. A draft with a `forum` or `press` variant gets one destination per account, so two forum accounts give two destinations.

- Accounts are created by hand in `/admin/social/conturi` ("Cont nou pentru publicare manuala"). The create function accepts every known platform and always makes a manual account; the form now says that the name is the forum or outlet and that the link is its page.
- `cleanUrl` in `accounts-actions.ts` (and the SQL function behind it) accepts **https (and http) only**, not `mailto:`. It stays that way: for a press outlet the account uses the outlet's contact page. A test checks that a `mailto:` link is refused.
- The generator writes a press release as the article: title, **lead as the subtitle**, body, and a short "Despre" paragraph. The checklist covers: sent to the editors, follow-up, and the published URL recorded (the "Mark as published" step).

## 2. Why each is manual

| Platform | Why |
| --- | --- |
| Quora | No publishing API (verified 2026-10-07). |
| LinkedIn (articol) | LinkedIn's Posts API cannot create articles or newsletter issues, only posts. `linkedin` and `linkedin-page` stay automatic for posts. |
| TradingView | No publishing API for Ideas or Minds. The checklist includes attaching or drawing the chart. |
| Investing.com | No API for community posts or comments. |
| Indie Hackers | No API. |
| Stack Exchange | A write API exists (`/questions/add`, `/answers/add` with the `write_access` scope), but the self-promotion rules require disclosing the affiliation in the post, and a person must judge whether the answer really answers the question. The **checklist has an item that the affiliation is disclosed**, the **generator prompt requires the disclosure**, and validation warns when the text has no affiliation wording. |
| GitHub | The REST API (`POST /repos/{owner}/{repo}/releases`) and GraphQL (`createDiscussion`) exist. A **direct integration is a later step**; for now a person pastes the note. |
| Forum | No common API; each forum differs. |
| Presa | Press releases go to a desk, usually by a contact form or e-mail. |

## 3. What changed

- **Site**: `constants.ts` (platforms, labels, kinds, manual-only list and reasons, card formats, editor URLs, `REDDIT_SUBREDDIT_SUGGESTIONS`), `validation.ts` (limits, required fields), `platform-settings.ts` (editor fields, preview lines and handoff fields from one table), `handoff.ts` (checklists; the article path reads fields from the settings table for LinkedIn articles, GitHub and press), `draft-edit.ts`, `draft-mapping.ts`, `fake/fixtures.ts` (`manual-channels` and `manual-articles`), `accounts-actions.ts`, `AccountsPanel.tsx` (hints), `DraftEditor.tsx` (a `<datalist>` for suggested values).
- **Reddit suggestions**: the subreddit field offers r/Romania, r/RoInvestitii, r/eupersonalfinance, r/Trading212, r/interactivebrokers and r/eToro from one constant. Any other subreddit still works.
- **Database**: `0010_manual_channels.sql` replaces `social_known_platforms()` and `social_manual_only_platforms()`. The platform checks (0008), the manual-only constraint and trigger (0009) and `social_admin_create_account` already call these functions, and nothing else lists platforms literally, so nothing more changes.
- **Worker**: `platforms.ts`, `generator/schema.ts`, `prompts.ts`, `validators.ts`, `variant-settings.ts`. The worker never receives jobs for these platforms and has no Postiz provider for them. The generator supplies a title where a site wants one (TradingView, Indie Hackers, a Stack Exchange question, a new forum thread); the question, symbol, instrument, thread, repository and tag are chosen by a person, so approval waits until they are filled.
- **Contract**: the `Platform` enum and the settings table in `docs/contracts/worker-api.openapi.yaml`.

## 4. Verification

- `cd site && npm run ci`: type check, lint, 361 tests, production build.
- `cd worker && npx --no-install tsc --noEmit && npm test`: 65 tests.
- New tests: limits and required fields per platform, forum exactly-one rule, Stack Exchange question rules and affiliation warning, drafts mapped for every account, handoff fields and checklists, migration 0010 (both SQL lists equal the site constants; none of the nine can be automatic), manual account creation (including the `mailto:` refusal) and a forum handoff end to end; on the worker side the mirrored tables, limits, the title rules, the settings the generator adds and the prompt text.

## 5. What the owner still has to do

- Create the accounts in `/admin/social/conturi`: one each for Quora, LinkedIn (articol), TradingView, Investing.com, Indie Hackers, Stack Exchange and GitHub; one per forum and per press outlet, each with the forum's or outlet's page as the editor link.
- Check the flagged limits against each site when first posting; they are one number each.
- Decide when a direct GitHub integration is worth building.
- Read each site's rules before posting (Stack Exchange self-promotion, Quora and forum rules, TradingView house rules).
