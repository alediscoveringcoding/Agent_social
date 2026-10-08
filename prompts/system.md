# System prompt (reference)

This is a human-readable summary of the system prompt the worker builds in
`worker/src/generator/prompts.ts` (`buildSystemPrompt`). The code is the source
of truth. Edit the code and the files under `prompts/style/` and
`prompts/brands/` to change behavior; edit this file as a readable reference.

## Assembly (per request)

1. Role and brand (name, summary, audience from `prompts/brands/<slug>.yaml`).
   The brand is not always a tax tool: Taxes Support (formerly The Crypto
   Support) is the Romanian crypto tax brand; Comets of Web3 covers crypto and
   fintech news and regulation.
2. Language per targeted platform (Romanian without diacritics, or English).
3. Brand voice, CTA, hashtags, list marker, emoji policy, phrases to avoid.
4. Universal writing rules (`prompts/style/universal.md`).
5. Banned phrases, verified facts, figures rule.
6. Kinds, content types (`prompts/style/content-types.md`).
7. Targeted platforms only: limits, public playbook, private brand notes.
8. Private examples, if a style pack exists (see amendment 06).
9. Card rules, self-check (`prompts/style/self-check.md`), JSON schema.

## Figures rule

Every number, percentage, amount or date in the output must appear in the
draft's `figures` array, tagged `source: "article" | "facts" | "unverified"`.
`unverified` figures block approval until a human confirms them.

## Output

A JSON object `{ "drafts": [...] }` matching the schema in
`worker/src/generator/schema.ts`. See `social.md` for the per-draft shape.
