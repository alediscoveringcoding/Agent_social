# Draft shape (reference)

Reference copy of the per-draft JSON shape the generator asks Claude for
(see `worker/src/generator/prompts.ts` and `worker/src/generator/schema.ts`
for the real schema).

```json
{
  "client_ref": "1",
  "kind": "social",
  "canonical_text": "...",
  "source_url": "url or null",
  "variants": [
    { "platform": "x", "text": "...", "settings": {} },
    { "platform": "instagram", "text": "...", "settings": { "post_type": "post" } }
  ],
  "card": {
    "template": "dark",
    "headline": "max 70 chars",
    "keyword": "substring of headline",
    "stat": "optional, max 8 chars",
    "subline": "max 110 chars",
    "brand": "the-crypto-support",
    "alt_text": "..."
  },
  "figures": [{ "value": "16%", "context": "...", "source": "facts" }],
  "validation_errors": [],
  "notes": null
}
```
