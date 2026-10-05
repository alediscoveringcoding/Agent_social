// JSON schema for structured output from Claude (draft + card spec, PRD section 10.5).
export const draftSchema = {
  type: "object" as const,
  properties: {
    drafts: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          client_ref: { type: "string" as const },
          kind: { type: "string" as const, enum: ["social", "article", "launch"] },
          title: { type: ["string", "null"] as const },
          canonical_text: { type: "string" as const },
          source_url: { type: ["string", "null"] as const },
          variants: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                platform: { type: "string" as const },
                text: { type: "string" as const },
                settings: { type: "object" as const },
              },
              required: ["platform", "text", "settings"],
            },
          },
          article: { type: ["object", "null"] as const },
          card: {
            type: "object" as const,
            properties: {
              template: { type: "string" as const, enum: ["dark", "light", "mint"] },
              headline: { type: "string" as const, maxLength: 70 },
              keyword: { type: "string" as const },
              stat: { type: ["string", "null"] as const, maxLength: 8 },
              subline: { type: "string" as const, maxLength: 110 },
              brand: { type: "string" as const },
              alt_text: { type: "string" as const },
            },
            required: ["template", "headline", "keyword", "subline", "brand", "alt_text"],
          },
          figures: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                value: { type: "string" as const },
                context: { type: "string" as const },
                source: { type: "string" as const, enum: ["article", "facts", "unverified"] },
              },
              required: ["value", "context", "source"],
            },
          },
          validation_errors: { type: "array" as const },
          notes: { type: ["string", "null"] as const },
        },
        required: ["client_ref", "kind", "canonical_text", "variants", "card", "figures"],
      },
    },
  },
  required: ["drafts"],
};
