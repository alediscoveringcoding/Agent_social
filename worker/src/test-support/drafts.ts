import type { ModelDraft } from '../generator/schema.js';

export function modelDraft(patch: Partial<ModelDraft> = {}): ModelDraft {
  return {
    client_ref: "one", kind: "social", title: "", canonical_text: "Taxes Support te ajuta sa pregatesti declaratia.", source_url: "",
    variants: [{ platform: "x", text: "Taxes Support te ajuta." }], article: null, launch: null,
    card: { template: "light", headline: "Pregateste declaratia", keyword: "declaratia", stat: "", subline: "Un pas simplu", alt_text: "Card despre declaratie" },
    figures: [], notes: "", ...patch,
  };
}
