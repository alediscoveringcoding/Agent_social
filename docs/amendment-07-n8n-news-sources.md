# Amendment 07: n8n automations, web news research and verified sources

Status: implemented locally (2026-10-10); n8n itself and the real web searches are untested against live services. Owner decisions taken on 2026-10-10:
- Romanian posts stay **without diacritics** (PRD content rule). The owner's original prompts are adapted to it.
- n8n alerts go by **email** (SMTP credentials live in n8n only).
- Web research is **opt-in per request**: the "Stiri recente" source in Genereaza, a "Cauta pe web" checkbox for a topic, and the scheduled n8n news runs. At most `RESEARCH_MAX_SEARCHES` (default 5) searches per request.
- Approval is **blocked until every source link is ticked as verified** by a person.

## 1. What changes

1. **Research step.** When a request asks for it, the worker first makes a research call with web search (Claude `web_search_20260209`; Gemini Google Search grounding). It returns a research brief: notes with `[S1]` markers and the list of sources the search actually returned. Then the normal writing call runs with the brief. A research request therefore costs **2 AI calls** (plus at most one repair) and the searches.
2. **Sources on drafts.** The writer cites sources only by id (`S3`), so it cannot invent links. The worker maps ids to the URLs found by the search and sends them with each draft. Web figures stay `unverified` with a `source_url`, so the existing figures gate still applies.
3. **Verification.** Sources are stored per post (`social_post_sources`). Each has a "Verificat" checkbox. `social_approve_revision` refuses with `SOCIAL_SOURCES_NOT_VERIFIED` while any source is unverified. After approval, sources are frozen.
4. **The owner's original Claude prompts** (`posts_framework/`, private) become private style-pack files, `prompts/private/<slug>/original/<platform>.md`. They are loaded in the writer's system prompt for the targeted platforms, and their selection and accuracy parts also go into the research prompt. Public, name-free content definitions go in `prompts/style/content-types.md` and `prompts/style/research.md`.
5. **Automation API** (PRD 10.4) for n8n, with `N8N_AUTOMATION_TOKEN`, plus n8n workflows in `n8n/workflows/` and `scripts/n8n-local.sh` to run n8n in WSL without Docker.

## 2. Contracts

### 2.1 Generation input (site `GenerationInputSchema`, stored in `social_generation_requests.input`)

```ts
source:
  | { type: 'article', url }
  | { type: 'topic', topic, hooks }
  | { type: 'news', topic: string /* optional focus, '' = brand topics */, window_days: number /* 1..30, default 7 */ }
research: boolean  // default false; the worker treats source.type === 'news' as research: true
```

### 2.2 Draft on the wire (worker → site, `DraftSchema`)

```ts
sources: Array<{
  url: string            // http(s), at most 2048
  title: string          // at most 300
  publisher?: string     // at most 200
  published_at?: string  // free text date as found, at most 40
  note?: string          // what it supports in the draft, at most 500
  found_in_search: boolean
}>                       // at most 20, default []
figures[i].source_url?: string  // the source behind a web figure, at most 2048
```

### 2.3 Worker model output (`ModelDraftSchema`, both providers)

Every field is required; "absent" is an empty string or an empty array, because of Claude's limit on optional parameters.

```ts
sources: Array<{ id: string /* "S3" from the brief */, note: string }>
figures[i].source_id: string   // "S3" or ""
```

The worker maps the ids to the brief's sources. An unknown id is a validation error (`source_unknown`). A research request whose draft cites no source gets `sources_missing`.

### 2.4 Research types (`worker/src/generator/research-types.ts`)

`ResearchSource { id, url, title, publisher, published_at, cited_text }` and `ResearchBrief { text, sources, searches, provider, model }`.

### 2.5 Database (migration `0012_sources_and_automation.sql`)

- `social_post_sources`: `id`, `post_id` (cascade), `position`, `url`, `title`, `publisher`, `published_at`, `note`, `found_in_search`, `verified_at`, `verified_by`, `created_at`, with `unique (post_id, url)`. RLS on, no policies, grants as in 0001.
- `social_add_post_sources(p_post uuid, p_sources jsonb, p_now timestamptz DEFAULT now()) RETURNS integer`: idempotent on `(post_id, url)`.
- `social_set_source_verified(p_source uuid, p_user uuid, p_verified boolean, p_now timestamptz DEFAULT now()) RETURNS jsonb`: logs activity. Refuses with `SOCIAL_SOURCES_FROZEN` while the post's current revision is approved.
- `social_approve_revision`: also refuses `SOCIAL_SOURCES_NOT_VERIFIED`.
- `social_automation_runs`: `id`, `workflow`, `event_id`, `status` (`ok` | `error` | `skipped`), `details` jsonb, `created_at`, with `unique (workflow, event_id)`.
- `social_automation_create_request(p_workflow text, p_event_id text, p_brand text, p_input jsonb, p_now timestamptz DEFAULT now()) RETURNS jsonb {request_id, created}`: idempotent on the existing `(workflow, event_id)` columns of `social_generation_requests`.
- `social_automation_log_run(p_workflow text, p_event_id text, p_status text, p_details jsonb, p_now timestamptz DEFAULT now()) RETURNS bigint`: an upsert.

### 2.6 Automation API (PRD 10.4)

Base `${SITE_BASE_URL}/api/automation/social/v1`, header `Authorization: Bearer ${N8N_AUTOMATION_TOKEN}` (32+ characters, constant-time comparison, 503 when unset). Contract in `docs/contracts/automation-api.openapi.yaml`.

| Method and path | Body → response |
| --- | --- |
| `POST /generation-requests` | `{workflow, event_id, brand, input}` → `{request_id, created}` |
| `GET /events?after={id}&limit={1..100}` | → `{events: [{id, type, created_at, payload}], next_after}` |
| `POST /runs` | `{workflow, event_id, status, details?}` → `{ok: true}` |

`workflow` matches `^[a-z0-9-]{1,64}$`, `event_id` is at most 200 characters, `brand` is a brand slug and `input` is validated by `GenerationInputSchema`. n8n can only create generation requests, read events and log runs. It cannot approve or publish (PRD D9).

### 2.7 Site modules

- `site/src/lib/social/sources-queries.ts`: `getPostSources(postId)` → `PostSource[]`.
- `site/src/lib/social/sources-actions.ts`: `setSourceVerified(sourceId, verified)` → `{ok: true} | {ok: false, error}`.
- `site/src/lib/social/automation-queries.ts`: `listAutomationRuns(limit)`.

## 3. n8n workflows (`n8n/workflows/`)

| File | Trigger | What it does |
| --- | --- | --- |
| `news-to-drafts.json` | Schedule (Mon, Wed, Fri 07:00 Bucharest) | For each configured brand, `POST /generation-requests` with `source.type = 'news'`. The `event_id` is `news-<brand>-<date>` |
| `article-to-drafts.json` | RSS poll of the blog | Each new article creates a request with `source.type = 'article'`. The `event_id` is `article-<brand>-<first 32 hex characters of SHA-256 of the guid or link>` |
| `events-to-email.json` | Every 5 minutes | `GET /events` from the stored cursor; emails the alert types to the admins; logs a run |
| `campaign-presets.json` | Schedule, inactive by default | Example preset (the "Declaratia Unica" countdown in May) |

The workflows hold placeholders only. The token is an n8n Header Auth credential and SMTP is an n8n SMTP credential. Both are created once in the n8n UI.

## 4. Cost

| Request | AI calls | Searches |
| --- | --- | --- |
| Without research | 1 (+1 repair at most) | 0 |
| With research | 2 (+1 repair at most) | at most `RESEARCH_MAX_SEARCHES` |

Claude web search is billed at $10 per 1,000 searches, plus the result tokens. `GENERATION_REPAIR=false` drops the repair call.

## 5. Follow-up fixes (2026-10-10, after review)

- **Migration `0013_retry_confirm_and_research_sources.sql`:**
  - A retry of a `POLL_TIMEOUT` job needs the same confirmation as `RECONCILE_MISS`, because the post may already be live.
  - `retry` is refused for a `submitted` job.
  - A post from a research request with no source cannot be approved (`SOCIAL_SOURCES_MISSING`).
  - A release by the kill switch refunds the attempt.
- **Events cursor:** `GET /events` also returns `latest_id`, so n8n notices a reset outbox. The email digest applies its 48-hour age filter only on the first run, so a long SMTP outage loses no alert.
- **Links:** on research requests, a draft's `source_url` and `variants[].link` must be a brief source or the request's article URL; anything else is cleared with a reviewer note. A URL in the post text that is neither is a validation error, `link_not_from_search`. Only x, facebook, telegram and bluesky may carry one URL in the text; LinkedIn and Instagram carry none.
- **Figures:** on research requests, figures are `unverified` unless they are an active verified fact.
- **Facts:** facts whose `valid_to` has passed are not given to the writer, and the writer prompt states today's date (Europe/Bucharest). The owner keeps `prompts/facts.yaml` current.
- **Research verdict:** news research uses the 9–10 audit and may answer "NO QUALIFYING STORY". Topic and article research only stop on "NO SOURCES FOUND". Neither verdict calls the writer.
- **Writer:**
  - With a brief it writes up to N drafts, never padding.
  - devto, hashnode and medium are dropped for non-article requests, because they need our blog's canonical URL.
- **Limits:** `RESEARCH_TIMEOUT_MS` is capped at 540000, inside the generation lease. Gemini counts every HTTP attempt as a call.
- **Brand topics:** private `news_topics` come before public ones (cap 14).
