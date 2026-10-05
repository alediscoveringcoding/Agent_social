# Project instructions

Read `docs/amendment-03-finish-the-site.md` and the relevant PRD section before changing behavior. Read `site/AGENTS.md` and the installed Next.js guide before changing the site.

- This repository is public. Never commit secrets, real `.env` files, personal account handles, legal names or the private root reports `another-social-media-report.md` and `deep-research-report.md`. Use `.env.example` placeholders.
- Run npm and Node only in Linux/WSL. The Windows checkout is shared with WSL at `/mnt/r/Repos/Agent_social`; Windows npm installs incompatible binaries. Node 22.6+ is required.
- Preserve the owner's staged or untracked changes. Stage explicit paths; avoid `git add .` and `git commit -a`.
- Local mode (`DB_MODE=local`) must work. PGlite and private storage live under `site/.local-db/`; one process owns the database. Use temporary databases for tests, never reset the owner's data to validate a change.
- Never call a real AI or publishing API in tests or routine checks. Inject provider clients or fetch. Use fake generation, fake delivery and `WORKER_DRY_RUN=true` for local acceptance.
- The browser cannot write social tables. Require an allowlisted, TOTP-verified admin inside every server action. Keep state transitions atomic in SQL functions; every mutation records activity.
- Local mode shares the fake Supabase client with tests. Stay within its supported query subset (`eq`, `neq`, `in`, `is`, comparisons, ordering, limits and embeds); no `.or()`.
- Approved revisions and their attachment copies are frozen. Content, schedule or media changes create a new revision and revoke approval. Recheck painted copy and figures from each attached image's immutable `card_spec`, rather than the revision's rendering default.
- Keep worker contracts and immutable hash vectors consistent. Add migrations with the next unused number after the latest migration; never modify an already-deployed migration.
- UI copy is Romanian without diacritics. Use existing components, action errors via `sonner`, and refresh after revision changes.
- Validate with `cd site && npm run ci` and `cd worker && npx --no-install tsc --noEmit && npm test`. `bash scripts/update.sh --no-pull` runs both. Stagger heavy CI runs on small WSL machines.
- Do not force-push or delete feature branches without permission. Do not use `npm audit fix --force` to downgrade the Next.js lint configuration.
