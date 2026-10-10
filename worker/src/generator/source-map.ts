// Amendment 07: the writer cites research sources by id ("S3"); the worker turns the ids into the
// URLs the search found, so a draft can never carry a link the model made up.
import type { ResearchBrief, ResearchSource } from "./research-types.js";
import type { ValidationError } from "./validators.js";

/** "s3", " [S3] " and "S3" are the same id. */
export const normalizeSourceId = (id: unknown): string => String(id ?? "").trim().replace(/^\[+|\]+$/g, "").trim().toUpperCase();

/**
 * Model draft -> wire draft sources. The result has `sources` as the site's DraftSource list and
 * figure `source_url` instead of `source_id`.
 * - Not a research request: sources are [] and every source_id is ignored.
 * - An id the brief does not have is dropped with `source_unknown`.
 * - A research request whose draft keeps no source gets `sources_missing`.
 * - A figure with a source is "unverified": it came from the web, so a person still checks it.
 * - A source only a figure cites is added to the draft's list, so every link gets verified.
 */
export function mapDraftSources(draft: any, research: ResearchBrief | undefined, researching: boolean): { draft: any; errors: ValidationError[] } {
  const { sources: modelSources, ...rest } = draft;
  const errors: ValidationError[] = [];
  if (!researching) {
    const figures = (draft.figures ?? []).map(({ source_id: _ignored, ...figure }: any) => figure);
    return { draft: { ...rest, sources: [], figures }, errors };
  }
  const byId = new Map<string, ResearchSource>((research?.sources ?? []).map((s) => [s.id.toUpperCase(), s]));
  const picked = new Map<string, { source: ResearchSource; note: string }>();
  const cite = (id: string, note: string) => {
    const source = byId.get(id);
    if (source && !picked.has(source.id)) picked.set(source.id, { source, note });
    return source;
  };
  for (const entry of Array.isArray(modelSources) ? modelSources : []) {
    if (!cite(normalizeSourceId(entry?.id), String(entry?.note ?? ""))) {
      errors.push({ rule: "source_unknown", message: `Source "${String(entry?.id ?? "")}" is not in the research brief; cite only ids from the brief`, field: "sources" });
    }
  }
  const figures = (draft.figures ?? []).map(({ source_id, ...figure }: any) => {
    const id = normalizeSourceId(source_id);
    if (!id) return figure;
    const source = cite(id, "");
    if (!source) {
      errors.push({ rule: "source_unknown", message: `Figure "${String(figure.value ?? "")}" cites source "${String(source_id)}", which is not in the research brief`, field: "figures.source_id" });
      return figure;
    }
    return { ...figure, source: "unverified", source_url: source.url };
  });
  if (picked.size === 0) errors.push({ rule: "sources_missing", message: "A draft written from research must list at least one source id from the brief", field: "sources" });
  const sources = [...picked.values()].map(({ source, note }) => ({
    url: source.url,
    title: source.title,
    ...(source.publisher ? { publisher: source.publisher } : {}),
    ...(source.published_at ? { published_at: source.published_at } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
    found_in_search: true,
  }));
  return { draft: { ...rest, sources, figures }, errors };
}

/** The reverse, for the repair prompt: wire sources and figure URLs back to the model's ids. */
export function restoreSourceIds(draft: any, research: ResearchBrief | undefined): { sources: Array<{ id: string; note: string }>; figures: any[] } {
  const idByUrl = new Map((research?.sources ?? []).map((s) => [s.url, s.id]));
  return {
    sources: (draft.sources ?? []).flatMap((s: any) => {
      const id = idByUrl.get(s.url);
      return id ? [{ id, note: s.note ?? "" }] : [];
    }),
    figures: (draft.figures ?? []).map(({ source_url, ...figure }: any) => ({ ...figure, source_id: (source_url && idByUrl.get(source_url)) || "" })),
  };
}
