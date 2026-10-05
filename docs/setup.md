# Platform setup guide (localhost MVP)

## Postiz initial setup

1. `node scripts/dev-up.mjs` (or `docker compose up -d` in `local/`)
2. Open http://localhost:4007
3. Create the admin user
4. Settings > Public API > generate an API key, put it in `worker/.env` as `POSTIZ_API_KEY`
5. Set `DISABLE_REGISTRATION=true` in `local/.env`, restart (`docker compose up -d` again in `local/`)

## Platform connections

### dev.to (1st priority)

- Auth: API key (no OAuth needed)
- Get key: https://dev.to/settings/extensions > Generate API key
- In Postiz: Settings > Integrations > dev.to > paste key
- Works on plain localhost: yes

### Hashnode (1st priority)

- Auth: Personal access token
- Get token: https://hashnode.com/settings/developer
- In Postiz: Settings > Integrations > Hashnode > paste token
- Works on plain localhost: yes

### X (2nd priority)

- Auth: OAuth
- Verify: does X's developer portal accept `http://localhost:4007` as a callback?
- If not: needs a tunnel (ngrok static domain or Cloudflare named tunnel)

### LinkedIn (2nd priority)

- Auth: OAuth
- Verify: does Postiz support a localhost redirect for LinkedIn?
- Manual posting until the Community Management API application is approved

### Facebook (3rd priority)

- Auth: OAuth
- Note: Meta fetches images from a URL it can reach — needs a tunnel or R2 for media

### Instagram (3rd priority)

- Auth: OAuth
- Same as Facebook; needs a public URL for images; Instagram Login may require HTTPS

## Status table

| Platform | Account | Owner | Status |
| --- | --- | --- | --- |
| dev.to | throwaway | Track B | not yet connected |
| Hashnode | throwaway | Track B | not yet connected |
| X | — | Track B | blocked on developer account + billing |
| LinkedIn | — | Track B | blocked on Community Management API application |
| Facebook | — | Track B | blocked on business verification |
| Instagram | — | Track B | blocked on Facebook |

Fill this table in as each account is connected (PRD task B2).
