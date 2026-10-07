# Postiz API notes (v2.25.0)

Living document — fill in the checked items below as task B3 (local Postiz
sandbox testing) confirms them.

## Base path

Self-hosted: `http://localhost:4007/api/public/v1`

## Authentication

Header: `Authorization: <api-key>` (no "Bearer" prefix)

## Rate limit

Default 30/hour; we set `API_LIMIT=90` in `local/docker-compose.yml` (our
volume is at most ~50 deliveries/day across all accounts).

## Key findings

- [ ] `POST /posts` with `type: "now"` immediately publishes
- [ ] Response includes: `id`, `group`, `releaseURL`
- [ ] `GET /integrations` returns connected channels with their IDs
- [ ] `POST /upload` accepts multipart, returns `{ id, path }`
- [ ] Upload-from-url does NOT work for localhost (SSRF protection) — multipart only (already assumed by `worker/src/loops/delivery.ts`)
- [ ] `DISABLE_REGISTRATION=true` works after first-user setup

## Post creation payload

Read from the v2.25.0 source on 2026-10-07 (amendment 04; still to be confirmed against a running instance in B3). `POST /public/v1/posts` takes Postiz's `CreatePostDto`; the worker builds it in `worker/src/delivery/postiz-payload.ts`:

```json
{
  "type": "now",
  "shortLink": false,
  "date": "2026-10-07T08:00:00.000Z",
  "tags": [],
  "posts": [
    {
      "integration": { "id": "<integration-id>" },
      "value": [
        { "content": "Hello world", "image": [{ "id": "<upload-id>", "path": "<upload-path>", "alt": "alt text" }] }
      ],
      "settings": { "__type": "bluesky" }
    }
  ]
}
```

- Postiz overwrites `settings.__type` with the integration's own provider identifier; settings are then validated against the provider's DTO (`libraries/nestjs-libraries/src/dtos/posts/providers-settings/`). A failed validation is a 400 with a readable message.
- The answer is a list: `[{ "postId": "...", "integration": "<integration-id>" }]`.
- `GET /public/v1/integrations` lists `{ id, name, identifier, picture, disabled, profile, customer }`: the provider is `identifier`, not `providerIdentifier`.
- `GET /public/v1/posts` needs `startDate` and `endDate` (ISO) and answers `{ "posts": [...] }`, each with `releaseURL`, `state` and `integration: { id, providerIdentifier, ... }`.
- Per-provider settings of the platforms added by amendment 04 are listed in [amendment 04](amendment-04-more-platforms.md).

## Status values observed

- TODO: fill after B3 testing against the real Postiz instance.
