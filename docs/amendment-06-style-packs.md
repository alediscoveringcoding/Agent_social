# Amendment 06: style packs for the post generator

Status: implemented in the worker (2026-10-08). Phase 2 is not started.

## Why

The generator used one system prompt for every brand: the same "Romanian crypto tax brand" voice, the limits of all 44 platforms on every request, and Romanian only. Posts came out generic. Good voice rules and good example posts exist, but real posts and brand lines must not live in a public repository.

## The layers

The system prompt is assembled per request, in this order:

1. Role and brand: name, summary, audience.
2. Language per targeted platform (`ro` is Romanian without diacritics, `en` is English); card text has its own language.
3. Brand voice: voice, CTA and hashtags per platform, list marker, emoji policy, phrases to avoid, disclaimer.
4. Universal writing rules (`prompts/style/universal.md`).
5. Banned phrases, verified facts and the figures rule (unchanged).
6. Kinds (only the requested ones).
7. Content types (`prompts/style/content-types.md`), with the brand's preferred order.
8. Platforms: only the targeted ones, each with its limits line (`PLATFORM_RULES`), the public playbook (`prompts/style/platforms/<platform>.md`) and the private brand notes.
9. Examples (private, optional), behind a guard line that forbids reusing facts.
10. Cards: limits and card craft.
11. Self-check (`prompts/style/self-check.md`).
12. The JSON-only instruction and the schema.

The user prompt asks for a different content type per draft.

## Files

```
prompts/style/universal.md, content-types.md, self-check.md
prompts/style/platforms/<platform>.md        public playbooks (linkedin-page uses linkedin)
prompts/brands/<slug>.yaml                   public generic brand profile
prompts/private.example/                     committed template with placeholders
prompts/private/                             gitignored; the real pack (STYLE_PACK_DIR)
  <slug>/brand.yaml
  <slug>/platforms/<platform>.md
  <slug>/examples/<platform>/<NN-name>.md
```

`brand.yaml` keys (the same in the public and private file; unknown keys are an error): `name`, `summary`, `audience`, `language` (`default`, `platforms`, `card`), `voice`, `content_types`, `cta` (per platform, with `default`), `hashtags` (the same), `bullet`, `emoji` (`none`, `bullets-only`, `light`), `avoid`, `disclaimer`.

Merge: a private value replaces the public one key by key; `language.platforms`, `cta` and `hashtags` merge per inner key. An example file is one post, with optional front matter (`content_type`, `note`). At most 2 examples per targeted platform are used, sorted by name, within 8,000 characters (later files drop first). See `prompts/private.example/README.md`.

## Fallback

A missing pack directory or brand folder is fine: the worker uses the public generic text (CI, fresh clones and tests behave this way). A file that is present but invalid (bad YAML, unknown key, bad front matter) fails the generation request with an error naming the file, rather than silently dropping the style.

## Deployment

`STYLE_PACK_DIR` in `worker/.env` points to the pack; the default is `prompts/private`. The pack is copied to the server like `.env` (for example `rsync -a prompts/private/ server:/path/prompts/private/`) and never committed. The worker reads it on each generation request, so no restart is needed after an edit.

## Brand names

The brand names live in the brand YAML. Taxes Support is the new name of The Crypto Support; `the-crypto-support` stays as the legacy brand with the same profile.

## Out of scope (phase 2, the owner decides)

First comment with sources, Instagram carousels, a per-brand card style, a hook and card consistency lint, a story audit score, series memory, cross-promotion as a data field.
