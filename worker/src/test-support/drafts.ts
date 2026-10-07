import type { ModelDraft } from "../generator/schema.js";

/** A model variant with the title and link fields empty, as for most platforms. */
export function variant(platform: ModelDraft["variants"][number]["platform"], text: string, extra: { title?: string; link?: string } = {}): ModelDraft["variants"][number] {
  return { platform, text, title: extra.title ?? "", link: extra.link ?? "" };
}

export function modelDraft(patch: Partial<ModelDraft> = {}): ModelDraft {
  return {
    client_ref: "one", kind: "social", title: "", canonical_text: "Taxes Support te ajuta sa pregatesti declaratia.", source_url: "",
    variants: [variant("x", "Taxes Support te ajuta.")], article: null, launch: null,
    card: { template: "light", headline: "Pregateste declaratia", keyword: "declaratia", stat: "", subline: "Un pas simplu", alt_text: "Card despre declaratie" },
    figures: [], notes: "", ...patch,
  };
}
