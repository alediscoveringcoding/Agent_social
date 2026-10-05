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

```json
{
  "type": "now",
  "posts": [
    {
      "content": "Hello world",
      "integration": "<integration-id>",
      "settings": {},
      "media": [{ "id": "<upload-id>", "path": "<upload-path>" }]
    }
  ]
}
```

## Status values observed

- TODO: fill after B3 testing against the real Postiz instance.
