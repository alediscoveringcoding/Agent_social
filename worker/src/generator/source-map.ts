// Amendment 07: the writer cites research sources by id ("S3"); the worker turns the ids into the
// URLs the search found, so a draft can never carry a link the model made up.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "yaml";
import { detectFigures, normalizeFigure } from "./figures.js";
import type { ResearchBrief, ResearchSource } from "./research-types.js";
import type { ValidationError } from "./validators.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FACTS_FILE = path.resolve(__dirname, "../../../prompts/facts.yaml");

/** "s3", " [S3] " and "S3" are the same id. */
export const normalizeSourceId = (id: unknown): string => String(id ?? "").trim().replace(/^\[+|\]+$/g, "").trim().toUpperCase();

// --- links ---

/**
 * The page a link points at, as a comparison key: no scheme, no "www.", no fragment, no trailing
 * slash. A model that writes "http://" for "https://" or adds a "/" still cites the same page.
 * "www.example.org/x" without a scheme is read as a link too (the site's link rule). null: not a URL.
 */
export function linkKey(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.host.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return null;
  }
}

/** The links a research draft may carry: the brief's sources and the request's own article. */
export function allowedLinkKeys(research: ResearchBrief | undefined, articleUrl?: string): Set<string> {
  const keys = new Set<string>();
  for (const url of [...(research?.sources ?? []).map((s) => s.url), articleUrl]) {
    const key = linkKey(url);
    if (key) keys.add(key);
  }
  return keys;
}

export const isAllowedLink = (url: unknown, allowed: ReadonlySet<string>): boolean => {
  const key = linkKey(url);
  return key !== null && allowed.has(key);
};

// --- verified facts ---

/**
 * Figures (normalized) that parsed verified facts state. Only the `fact` texts count, not the
 * validity dates or the legal source. Pass the facts that hold today (prompts.ts activeFacts), the
 * ones the writer was given.
 */
export function factFigures(facts: unknown): string[] {
  const out = new Set<string>();
  const walk = (node: unknown, key = "") => {
    if (typeof node === "string") {
      if (key === "fact") for (const figure of detectFigures(node)) out.add(normalizeFigure(figure.value));
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item, key);
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, k);
    }
  };
  walk(facts);
  return [...out];
}

let rawFacts: unknown;
/** prompts/facts.yaml parsed, once. A missing or broken file reads as no facts, so no figure counts as verified. */
export function loadFacts(): unknown {
  if (rawFacts === undefined) {
    try { rawFacts = yaml.parse(fs.readFileSync(FACTS_FILE, "utf8")) ?? {}; } catch { rawFacts = {}; }
  }
  return rawFacts;
}

const BARE_NUMBER = /^\d+(?:\.\d+)?$/;
const numberIn = (normalized: string): string | null => normalized.match(/\d+(?:\.\d+)?/)?.[0] ?? null;

/** Equal after normalization, or one side is a bare number equal to the other side's number. */
function sameFigure(a: string, b: string): boolean {
  if (a === b) return true;
  if (BARE_NUMBER.test(a) && numberIn(b) === a) return true;
  if (BARE_NUMBER.test(b) && numberIn(a) === b) return true;
  return false;
}

const clip = (text: string, max = 200): string => (text.length > max ? `${text.slice(0, max)}...` : text);
const withNotes = (existing: unknown, added: string[]): string => {
  const lines = String(existing ?? "").trim() ? [String(existing).trim()] : [];
  for (const note of added) if (!lines.some((line) => line.includes(note))) lines.push(note);
  return lines.join("\n");
};

export interface MapOptions {
  /** The request's own article URL (source.type "article"): a link the draft may keep. */
  articleUrl?: string;
  /** Normalized figures of the verified facts that hold today (factFigures). Default: none, so nothing counts as verified. */
  facts?: readonly string[];
}

/**
 * Model draft -> wire draft sources. The result has `sources` as the site's DraftSource list and
 * figure `source_url` instead of `source_id`.
 * - Not a research request: sources are [] and every source_id is ignored.
 * - An id the brief does not have is dropped with `source_unknown`.
 * - A research request whose draft keeps no source gets `sources_missing`.
 * - A figure with a source is "unverified": it came from the web, so a person still checks it.
 *   So is every other figure of a research request, unless it is "facts" and the verified facts state it.
 * - A source only a figure cites is added to the draft's list, so every link gets verified.
 * - A source_url or variant link that is neither in the brief nor the request's article is replaced
 *   (source_url: by the first cited source's URL, else ""; link: by ""), with a reviewer note and no
 *   validation error, so no paid repair is spent on it.
 */
export function mapDraftSources(draft: any, research: ResearchBrief | undefined, researching: boolean, opts: MapOptions = {}): { draft: any; errors: ValidationError[] } {
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
  const inFacts = (value: unknown): boolean => {
    const wanted = normalizeFigure(String(value ?? ""));
    return wanted !== "" && (opts.facts ?? []).some((known) => sameFigure(known, wanted));
  };
  const figures = (draft.figures ?? []).map(({ source_id, ...figure }: any) => {
    const id = normalizeSourceId(source_id);
    if (id) {
      const source = cite(id, "");
      if (source) return { ...figure, source: "unverified", source_url: source.url };
      errors.push({ rule: "source_unknown", message: `Figure "${String(figure.value ?? "")}" cites source "${String(source_id)}", which is not in the research brief`, field: "figures.source_id" });
    }
    // No web source behind it: the model's "facts" or "article" label must not skip the human check.
    return figure.source === "facts" && inFacts(figure.value) ? figure : { ...figure, source: "unverified" };
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

  // Links must come from the search (or be the request's own article); never from the model's memory.
  const allowed = allowedLinkKeys(research, opts.articleUrl);
  const notes: string[] = [];
  let sourceUrl = rest.source_url;
  if (typeof sourceUrl === "string" && sourceUrl.trim() && !isAllowedLink(sourceUrl, allowed)) {
    const replacement = sources[0]?.url ?? "";
    notes.push(`Linkul sursa ${clip(sourceUrl.trim())} nu venea din cautarea pe web si a fost ${replacement ? `inlocuit cu ${replacement}` : "scos"}.`);
    sourceUrl = replacement;
  }
  const variants = Array.isArray(rest.variants) ? rest.variants.map((v: any) => {
    if (typeof v?.link !== "string" || !v.link.trim() || isAllowedLink(v.link, allowed)) return v;
    notes.push(`Linkul ${clip(v.link.trim())} pentru ${String(v.platform)} nu venea din cautarea pe web si a fost scos.`);
    return { ...v, link: "" };
  }) : rest.variants;
  return {
    draft: {
      ...rest,
      ...(rest.source_url !== undefined ? { source_url: sourceUrl } : {}),
      ...(variants !== undefined ? { variants } : {}),
      ...(notes.length ? { notes: withNotes(rest.notes, notes) } : {}),
      sources,
      figures,
    },
    errors,
  };
}

/** Add reviewer notes to a draft's `notes`, skipping lines that are already there. */
export function addReviewerNotes<T extends { notes?: unknown }>(draft: T, added: string[]): T {
  return added.length ? { ...draft, notes: withNotes(draft.notes, added) } : draft;
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
