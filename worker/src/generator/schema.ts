import { z } from "zod";
import { PLATFORMS } from "../platforms.js";

// Both providers use this closed schema. Length limits are in descriptions:
// Gemini does not accept maxLength; content is checked after parsing.
const article = z.strictObject({
  title: z.string().describe("Article title, at most 300 characters"),
  subtitle: z.string().describe("Subtitle; empty string when absent"),
  body_markdown: z.string().describe("Complete Romanian article in Markdown"),
  tags: z.array(z.string()).describe("At most four short tags; at most three, each at most 25 characters, when medium is a target"),
  canonical_url: z.string().describe("Original article URL on our blog; empty when absent"),
});
const launch = z.strictObject({
  name: z.string(),
  tagline: z.string().describe("At most 60 characters"),
  description: z.string().describe("At most 260 characters"),
  maker_comment: z.string().describe("Maker comment; empty when absent"),
});
export const ModelDraftSchema = z.strictObject({
  client_ref: z.string().describe("Unique nonempty batch reference, at most 64 characters"),
  kind: z.enum(["social", "article", "launch"]),
  title: z.string().describe("Title; empty string when absent"),
  canonical_text: z.string(),
  source_url: z.string().describe("Source URL; empty string when absent"),
  variants: z.array(z.strictObject({
    platform: z.enum(PLATFORMS),
    text: z.string().describe("Social copy; empty string for article and launch destinations"),
    // Optional-looking fields are required strings: Claude structured outputs
    // allow at most 24 optional parameters, so "absent" is an empty string.
    title: z.string().describe("Post title for reddit (at most 300 characters), pinterest (at most 100) and lemmy (3 to 200); empty string for every other platform"),
    link: z.string().describe("Destination URL for pinterest and optional link for lemmy, normally the source URL; empty string for every other platform"),
  })),
  article: article.nullable(),
  launch: launch.nullable(),
  card: z.strictObject({
    template: z.enum(["dark", "light", "mint"]),
    headline: z.string().describe("At most 70 characters, Romanian without diacritics"),
    keyword: z.string().describe("A word appearing in headline"),
    stat: z.string().describe("At most 8 characters; empty string when absent"),
    subline: z.string().describe("At most 110 characters"),
    alt_text: z.string().describe("Nonempty accessible description of the card"),
  }),
  figures: z.array(z.strictObject({
    value: z.string(),
    context: z.string(),
    source: z.enum(["article", "facts", "unverified"]),
  })),
  notes: z.string().describe("Reviewer notes; empty string when absent"),
});
export const ModelResponseSchema = z.strictObject({ drafts: z.array(ModelDraftSchema) });
const { $schema: _dialect, ...schema } = z.toJSONSchema(ModelResponseSchema);
void _dialect;
export const draftSchema = schema;
export type ModelDraft = z.infer<typeof ModelDraftSchema>;

/** Normalize harmless casing before validating the provider response. */
export function parseModelResponse(text: string): ModelDraft[] {
  const raw: unknown = JSON.parse(text);
  if (raw && typeof raw === "object" && "drafts" in raw && Array.isArray(raw.drafts)) {
    for (const draft of raw.drafts) {
      if (!draft || typeof draft !== "object") continue;
      if (typeof draft.kind === "string") draft.kind = draft.kind.toLowerCase();
      if (typeof draft.card?.template === "string") draft.card.template = draft.card.template.toLowerCase();
      for (const v of Array.isArray(draft.variants) ? draft.variants : []) {
        if (typeof v?.platform === "string") v.platform = v.platform.toLowerCase();
      }
      for (const f of Array.isArray(draft.figures) ? draft.figures : []) {
        if (typeof f?.source === "string") f.source = f.source.toLowerCase();
      }
    }
  }
  const result = ModelResponseSchema.parse(raw);
  if (result.drafts.length < 1 || result.drafts.length > 50 ||
      result.drafts.some(d => !d.client_ref || d.client_ref.length > 64) ||
      new Set(result.drafts.map(d => d.client_ref)).size !== result.drafts.length) {
    throw new Error("Invalid draft batch references or size");
  }
  return result.drafts;
}
