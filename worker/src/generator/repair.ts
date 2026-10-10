import type { ResearchBrief } from "./research-types.js";
import { restoreSourceIds } from "./source-map.js";

// Builds the one allowed repair prompt when a draft batch fails validation (PRD F2).
// `research` is the brief the drafts were written from: the repaired drafts must keep citing its ids.
export function buildRepairPrompt(drafts: any[], research?: ResearchBrief): string {
  const errorsSection = drafts
    .filter((d: any) => d.validation_errors.length > 0)
    .map((d: any) => {
      const errs = d.validation_errors
        .map((e: any) => `- ${e.rule}: ${e.message}`)
        .join("\n");
      return `Draft "${d.client_ref}":\n${errs}`;
    })
    .join("\n\n");

  const failing = drafts.filter(d => d.validation_errors.length > 0);
  // settings, brand and validation_errors belong to the worker, not the
  // provider schema. Show only fields the model can return.
  const originals = failing.map(({ validation_errors, variants, card, ...draft }) => ({
    ...draft,
    title: draft.title ?? "", source_url: draft.source_url ?? "", notes: draft.notes ?? "",
    // The model's schema has title and link per variant; the worker kept them as settings.
    variants: variants.map(({ settings, ...variant }: any) => ({ ...variant, title: settings?.title ?? "", link: settings?.link ?? "" })),
    card: { ...card, brand: undefined, stat: card.stat ?? "" },
    article: draft.article ? { ...draft.article, subtitle: draft.article.subtitle ?? "", canonical_url: draft.article.canonical_url ?? "" } : null,
    launch: draft.launch ? { ...draft.launch, maker_comment: draft.launch.maker_comment ?? "" } : null,
    // The site gets URLs; the model cites ids from the brief (amendment 07).
    ...restoreSourceIds(draft, research),
  }));
  const sources = research
    ? `\n\nSOURCES (cite only these ids in sources and in figures[].source_id; never invent a source or a URL):\n${research.sources.map((s) => `${s.id}: ${s.title} | ${s.publisher} | ${s.published_at} | ${s.url}`).join("\n")}`
    : "";
  return `Fix only the failing drafts below. Return the same client_ref for each, no new drafts. Respond with the provider JSON schema.\n\nErrors:\n${errorsSection}\n\nOriginal drafts:\n${JSON.stringify(originals, null, 2)}${sources}`;
}

/** Keep batch order and valid originals; accept only an actual improvement. */
export function mergeRepairs<T extends { client_ref: string; validation_errors: unknown[] }>(originals: T[], repaired: T[]): T[] {
  const byRef = new Map<string, T>();
  for (const draft of repaired) {
    const known = byRef.get(draft.client_ref);
    if (!known || draft.validation_errors.length < known.validation_errors.length) byRef.set(draft.client_ref, draft);
  }
  return originals.map(original => {
    const replacement = byRef.get(original.client_ref);
    return original.validation_errors.length > 0 && replacement && replacement.validation_errors.length < original.validation_errors.length ? replacement : original;
  });
}
