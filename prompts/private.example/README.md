# Style packs

A style pack holds the private part of the generator's voice: brand overrides, platform notes and real example posts. The real pack lives in `prompts/private/` (gitignored); this folder is a template with placeholders.

1. Copy `example-brand/` to `prompts/private/<brand-slug>/` (for example `taxes-support`).
2. Edit `brand.yaml`. It uses the keys of `prompts/brands/<slug>.yaml`; unknown keys are an error. Values replace the public ones (`language.platforms`, `cta` and `hashtags` merge key by key).
3. Add `platforms/<platform>.md` for notes appended after the public playbook of that platform (`linkedin-page` uses `linkedin`).
4. Add `examples/<platform>/<NN-name>.md`, one real, cleaned post per file, with optional front matter (`content_type`, `note`). At most 2 per platform and 8,000 characters in all are used.
5. Point the worker at it with `STYLE_PACK_DIR` (default `prompts/private`). A missing pack means the public generic text.

Never commit a real pack.
