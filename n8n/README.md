# n8n automations

Four ready-made n8n workflows that talk to the site's automation API (amendment 07, PRD 10.4). They create **drafts** and send **email alerts**. A person still approves and publishes everything in `/admin/social`.

What n8n can and cannot do:

- It can create generation requests (drafts in Ciorne), read the event feed and log its own runs.
- It cannot approve, schedule or publish anything, and it holds no Supabase key, no Postiz key and no admin session. The site's automation API has only three routes and a single bearer token.
- It listens on `127.0.0.1` only and needs no public webhook.

Everything here runs on your machine in WSL, without Docker. n8n is pinned to **1.123.82** (see [Upgrading](#upgrading-n8n)). Its data (database and encrypted credentials) lives in `~/.agent-social-n8n`, never in this repository.

## Setup

1. **Start the site.** Run `bash scripts/update.sh --no-pull` once (it adds `N8N_AUTOMATION_TOKEN` to `site/.env.local` when it is missing), then `bash scripts/dev-local.sh` (site and worker). The site must be up at <http://127.0.0.1:3000> whenever a workflow runs, and the worker (or `npm run social:fake-generator -- --once` in `site/`) writes the drafts for the requests n8n creates.
2. **Import the workflows, then start n8n** (both in WSL, from the repository root):

   ```bash
   bash scripts/n8n-local.sh --import   # imports n8n/workflows/*.json, inactive, then exits
   bash scripts/n8n-local.sh            # starts n8n; Ctrl+C stops it
   ```

   The first run downloads n8n through `npx` and takes several minutes. If the import says it cannot find the owner, start n8n once, create the owner account (step 3), stop it with Ctrl+C and run `--import` again.
3. **Open <http://127.0.0.1:5678>** and create the owner account. It stays on this machine.
4. **Create the two credentials** (Credentials, then Create credential). The names must match exactly:

   | Name | Type | Fields |
   | --- | --- | --- |
   | `Agent Social automation` | Header Auth | Name `Authorization`, Value `Bearer ` followed by the value of `N8N_AUTOMATION_TOKEN` from `site/.env.local` |
   | `Agent Social SMTP` | SMTP | Your mail server: host, port, user, password, SSL/TLS as your provider says |

   Copy the token from the file with your editor; do not print it in a terminal or paste it anywhere else. If a node still shows a missing credential, pick it in the node, or stop n8n, run `--import` again (it matches credentials by name) and start n8n, before you edit the Config nodes.
5. **Edit the Config node of each workflow** (the table below lists the fields). The files hold placeholders only: `http://127.0.0.1:3000`, `alerts@example.com`, `admin@example.com`, `https://example.com/blog/rss.xml`. In `article-to-drafts` also set the **Feed URL** on the RSS node.
6. **Activate** the workflows you want with the toggle at the top right of each workflow. All four are inactive after the import. Use **Execute workflow** on `news-to-drafts` once if you want to see a result straight away (it creates real draft requests and costs AI calls).

Check the result in the site: **Genereaza** and **Ciorne** show the requests and drafts, and the **Automatizari** card on the overview lists the runs n8n reported.

## The workflows

| File | Schedule | What it does | Event id (`workflow` + `event_id` is unique, so a repeat creates nothing) |
| --- | --- | --- | --- |
| `news-to-drafts.json` | Mon, Wed, Fri at 07:00 Bucharest | For each brand in Config: request with `source.type = news`, web search on. Then logs one run per brand | `news-<brand>-<yyyy-MM-dd>` |
| `article-to-drafts.json` | Polls the blog RSS feed every 30 minutes | Each new article creates one request with `source.type = article` (no web search) | the item guid, or its link |
| `events-to-email.json` | Every 5 minutes | Reads the event feed after the saved cursor and sends one digest email when there are alerts | run ids `events-<last event id>`, `idle-<yyyy-MM-dd-HH>`, `events-error-...` |
| `campaign-presets.json` | May, Mondays and Thursdays at 08:00 | Example: the "Declaratia Unica" countdown, a topic request for `taxes-support` with the days left | `campaign-<key>-<yyyy-MM-dd>` |

Nodes, in short:

- **news-to-drafts**: Schedule Trigger, Config (Set), Build requests (Code), Create generation request (HTTP), Prepare run logs (Code), Log run (HTTP).
- **article-to-drafts**: RSS Feed Trigger, Config, Build requests, Create generation request, Prepare run logs, Log run.
- **events-to-email**: Schedule Trigger, Config, Read cursor (Code), Fetch events (HTTP), Build digest (Code), Any alerts? (If), Send digest (Send Email), Save cursor (Code), Email failed (Code), Log run (HTTP).
- **campaign-presets**: Schedule Trigger (cron `0 0 8 * 5 1,4`), Config, Build requests, Create generation request, Prepare run logs, Log run.

### Config fields

| Workflow | Field | Meaning |
| --- | --- | --- |
| all | `siteBaseUrl` | Where the site runs, without a trailing slash |
| news | `brands[]` | One entry per brand: `slug`, `platforms`, `templates` (`dark`, `light`, `mint`), `count` (posts per run), `window_days` (1 to 30), `topic` (optional focus, empty = the brand's own topics) |
| article, campaign | `brand` | `slug`, `platforms`, `templates`, `count` |
| article | `research` | `true` also searches the web for each article (2 AI calls) |
| campaign | `campaign` | `key`, `name`, `deadlineMonth`, `deadlineDay`, `hooks`, `research` |
| events | `adminUrl`, `alertFrom`, `alertTo`, `maxAgeHours` | Link in the email, sender, recipients (comma separated), and how old an event may be and still be emailed (default 48 hours) |

Defaults: `taxes-support` posts to `linkedin` and `instagram`; `comets-of-web3` to `linkedin`, `linkedin-page` and `instagram`. `the-crypto-support` is a legacy brand and is not scheduled. Platform ids and templates must exist in the site (`site/src/lib/social/constants.ts`); a wrong value makes the site answer 422, which is logged as an error run and does not stop the other brands.

### How they behave

- **Safe to repeat.** The site creates one request per `workflow` + `event_id`; a second call answers `created: false` and the run is logged as `skipped`.
- **A failing brand does not stop the others.** Each HTTP node continues on failure (three tries for the create call) and the outcome, `ok`, `skipped` or `error` with the status code, goes to the Automatizari card.
- **Events email.** One digest per run, in Romanian without diacritics, one short line per event and a link to <http://localhost:3000/admin/social>. Types: `delivery_failed`, `delivery_stale`, `account_reconnect_required`, `manual_due`, `drafts_ready`, `generation_failed`, `foreign_post`, `worker_silent`. Nothing is sent when there is nothing new. The cursor is saved only after the email went out, so a mail server outage repeats the same events 5 minutes later. The cursor is workflow static data, which n8n keeps **only while the workflow is active**: a manual test run does not move it. Events older than `maxAgeHours` are skipped, so the first run does not mail your whole history; a long backlog drains 100 events per run.
- **Campaign preset.** The topic reads like "Declaratia Unica 2026: mai sunt 21 zile pana la termenul limita din 25 mai". The date is in Config: confirm the deadline for the year before you activate it. The number of days becomes a figure in the draft that a person has to confirm before approval. After the deadline the workflow creates nothing.
- **Article feed.** The first poll after activation only remembers the feed; older articles are not imported.

## Cost

Every request that searches the web (every `news-to-drafts` request, and `research: true` anywhere) is **2 AI calls plus up to 5 web searches** (`RESEARCH_MAX_SEARCHES` in `worker/.env`), plus one repair call when a draft fails the content rules (`GENERATION_REPAIR=false` drops it). A request without research is 1 AI call.

With the default Config, `news-to-drafts` makes 2 brands x 3 runs a week = 6 research requests a week: 12 AI calls and at most 30 searches. Claude web search is billed at $10 per 1,000 searches plus the result tokens, so the searches are at most about $0.30 a week; the AI calls are the larger part. `article-to-drafts` costs 1 AI call per new article and brand. The events workflow costs nothing but your SMTP quota.

Lower the cost by removing a brand from Config, lowering `count` or `window_days`, or running news only on some days (edit the Schedule Trigger).

## Pause, stop, rotate

- **Pause one workflow**: switch its Active toggle off.
- **Pause everything**: Ctrl+C in the terminal that runs `scripts/n8n-local.sh`. Nothing runs while n8n is down; missed schedules are not replayed.
- **Cut n8n off from the site**: remove the value of `N8N_AUTOMATION_TOKEN` in `site/.env.local` and restart the site; the automation API then answers 503 to every call.
- **Rotate the token**: put a new 64-character hex value in `site/.env.local`, restart the site, and update the `Agent Social automation` credential in n8n.
- Drafts that n8n already created stay in Ciorne until a person approves or discards them.

## Notes

- Re-running `--import` replaces the imported workflows (they keep fixed ids) and loses editor changes, including a filled-in Config node. Import once and keep a copy of your Config values. Changes that belong to everyone go back into `n8n/workflows/` through a pull request (export without credentials, keep placeholders only).
- The workflows only use Code nodes for plain JavaScript on the node's own data; the HTTP calls use the credential, so no token appears in any workflow file. Do not export a workflow with credentials included.
- Time zone is Europe/Bucharest (workflow setting, `GENERIC_TIMEZONE` and `TZ`).
- n8n starts with telemetry, update checks and templates off, task runners off, and `$env` access from nodes blocked.

## Upgrading n8n

The version is pinned in `scripts/n8n-local.sh` (`N8N_VERSION`). It is the newest release that was at least 14 days old when chosen and that runs on Node 22: every n8n 2.x from 2.9 needs Node 22.16 or newer, and the current ones need Node 24. To move to n8n 2.x, install a Node version it accepts (`npm view n8n@<version> engines`), set `N8N_RUNNERS_ENABLED` as that version needs (2.x always runs task runners; check that `$getWorkflowStaticData` still works in the events workflow), re-import and run each workflow once with Execute workflow before activating it.
