// Research step (amendment 07): one web-search call before the writer, for both providers.
// It returns notes with [S#] markers and the sources the search actually returned. Sources come
// only from search results or citations, never from the model's free text.
import { config } from "../config.js";
import { logger } from "../logger.js";
import { AiOutputError } from "../services/ai-errors.js";
import * as claude from "../services/claude-api.js";
import * as gemini from "../services/gemini-api.js";
import { requireKey, type AiChoice } from "../services/llm.js";
import { SOURCE_LIMITS } from "./wire-bounds.js";
import type { ResearchBrief, ResearchSource } from "./research-types.js";

export const MAX_SOURCES = SOURCE_LIMITS.count;
/** Time limit for the whole step (every call, continuations included) when RESEARCH_TIMEOUT_MS is unset. */
export const DEFAULT_RESEARCH_TIMEOUT_MS = 300_000;
const QUOTE_MAX = 300;
const REDIRECT_TIMEOUT_MS = 10_000;
// Redirects resolved per answer; dedupe may merge a few of them.
const MAX_RESOLVED = 40;

/** Added to the notes when Claude was still paused at the call or search cap. The writer sees it. */
export const STOPPED_EARLY_NOTE = "(research stopped early: search or call limit reached)";

/** A brief plus how many HTTP calls it took (Claude: 1 plus pause_turn continuations; Gemini: attempts, retries included). */
export type ResearchResult = ResearchBrief & { calls: number };
/** What the generator loop needs from a research function (tests inject a fake). */
export type ResearchRunner = (
  systemPrompt: string, userPrompt: string, choice: AiChoice, opts?: ResearchOptions,
) => Promise<ResearchBrief & { calls?: number }>;

export interface ResearchOptions {
  signal?: AbortSignal;
  /** Search cap for this request. Default: RESEARCH_MAX_SEARCHES. */
  maxSearches?: number;
  /** Limit for the whole step. Default: RESEARCH_TIMEOUT_MS, else 5 minutes. */
  timeoutMs?: number;
  /** Test seams: a fake Anthropic client, and a fake fetch (Gemini REST and redirect lookups). */
  client?: claude.ClaudeClient;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Research call with web search. Dedicated prompts come from buildResearchPrompts.
 * Throws AiNotConfiguredError, AiOutputError or an Error; an empty `sources` is for the caller to judge.
 */
export async function runResearch(
  systemPrompt: string,
  userPrompt: string,
  choice: AiChoice,
  opts: ResearchOptions = {},
): Promise<ResearchResult> {
  requireKey(choice);
  const maxSearches = Math.max(1, Math.floor(opts.maxSearches ?? config.RESEARCH_MAX_SEARCHES));
  const timeoutMs = opts.timeoutMs ?? config.RESEARCH_TIMEOUT_MS ?? DEFAULT_RESEARCH_TIMEOUT_MS;
  // One deadline for the whole step, shared by every call it makes.
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  // Claude enforces max_uses; Gemini has no cap parameter, so both are told.
  const system = `${systemPrompt}\n\nSearch budget: use at most ${maxSearches} web searches in total.`;
  try {
    return choice.provider === "gemini"
      ? await researchWithGemini(system, userPrompt, choice.model, maxSearches, signal, opts)
      : await researchWithClaude(system, userPrompt, choice.model, maxSearches, signal, opts);
  } catch (err) {
    if (timeout.aborted && !opts.signal?.aborted) throw new Error(`Research timed out after ${timeoutMs} ms`, { cause: err });
    throw err;
  }
}

// --- sources ---

const clip = (value: string | null | undefined, max: number) => Array.from((value ?? "").trim()).slice(0, max).join("");
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./i, "").toLowerCase(); } catch { return ""; } };

/** The URL as given when it is http(s) and fits the site's limit; else undefined. */
function cleanUrl(raw: string | null | undefined): string | undefined {
  const url = (raw ?? "").trim();
  if (!url || url.length > SOURCE_LIMITS.url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : undefined;
  } catch { return undefined; }
}
/** Same page: the fragment does not count. */
function urlKey(url: string): string { const u = new URL(url); u.hash = ""; return u.href; }

interface RawSource { url: string | null | undefined; title?: string | null; publisher?: string; published_at?: string | null; cited_text?: string | null }

/** Sources in first-seen order, deduped by URL, at most MAX_SOURCES. */
class SourceList {
  readonly list: ResearchSource[] = [];
  private readonly byKey = new Map<string, ResearchSource>();

  add(raw: RawSource): ResearchSource | undefined {
    const url = cleanUrl(raw.url);
    if (!url) return undefined;
    const key = urlKey(url);
    let source = this.byKey.get(key);
    if (!source) {
      if (this.list.length >= MAX_SOURCES) return undefined;
      // Unless the caller knows better, the publisher is the page's host.
      source = { id: `S${this.list.length + 1}`, url, title: "", publisher: clip(raw.publisher ?? hostOf(url), SOURCE_LIMITS.publisher), published_at: "", cited_text: "" };
      this.list.push(source);
      this.byKey.set(key, source);
    }
    // The first non-empty value wins.
    source.title ||= clip(raw.title, SOURCE_LIMITS.title);
    source.published_at ||= clip(raw.published_at, SOURCE_LIMITS.published_at);
    source.cited_text ||= clip(raw.cited_text, QUOTE_MAX);
    return source;
  }

  /** Every source needs a title for the person who verifies it. */
  done(): ResearchSource[] {
    for (const source of this.list) source.title ||= source.publisher || hostOf(source.url);
    return this.list;
  }
}

/** Append [S#] markers to text, before any trailing whitespace. */
function mark(text: string, ids: string[]): string {
  if (!ids.length) return text;
  const body = text.trimEnd();
  return `${body}${ids.map((id) => `[${id}]`).join("")}${text.slice(body.length)}`;
}

// --- Claude ---

interface Parsed { text: string; sources: ResearchSource[]; errors: string[] }

/**
 * Notes and sources from the content of a web-search answer. Ids go first to the pages the text
 * cites (in order of first citation), then to the other search results, so the cap of 20 can never
 * cut a cited page. A tool result is either a list of results or one error object.
 */
export function parseClaudeContent(content: claude.ClaudeMessage["content"]): Parsed {
  const results: Array<{ url: string; title: string; page_age: string | null }> = [];
  const errors: string[] = [];
  for (const block of content) {
    if (block.type !== "web_search_tool_result") continue;
    if (Array.isArray(block.content)) {
      for (const result of block.content) if (result?.type === "web_search_result") results.push(result);
    } else if (block.content && typeof block.content === "object") {
      errors.push(String((block.content as { error_code?: unknown }).error_code ?? "unknown"));
    }
  }
  const found = new Map<string, (typeof results)[number]>();
  for (const result of results) {
    const url = cleanUrl(result.url);
    if (url && !found.has(urlKey(url))) found.set(urlKey(url), result);
  }
  const lookup = (url: string) => { const clean = cleanUrl(url); return clean ? found.get(urlKey(clean)) : undefined; };

  const sources = new SourceList();
  let text = "";
  for (const block of content) {
    if (block.type !== "text") continue;
    const ids: string[] = [];
    for (const citation of block.citations ?? []) {
      if (citation.type !== "web_search_result_location") continue;
      const result = lookup(citation.url);
      const source = sources.add({ url: citation.url, title: citation.title ?? result?.title, published_at: result?.page_age, cited_text: citation.cited_text });
      if (source && !ids.includes(source.id)) ids.push(source.id);
    }
    text += mark(block.text, ids);
  }
  for (const result of results) sources.add({ url: result.url, title: result.title, published_at: result.page_age });
  return { text: text.trim(), sources: sources.done(), errors };
}

async function researchWithClaude(
  system: string, user: string, model: string, maxSearches: number, signal: AbortSignal, opts: ResearchOptions,
): Promise<ResearchResult> {
  const raw = await claude.searchWeb(system, user, model, { maxSearches, client: opts.client, signal });
  const parsed = parseClaudeContent(raw.content);
  for (const code of parsed.errors) logger.warn("Web search returned an error", { error_code: code });
  if (!parsed.text) {
    throw new AiOutputError("AI_BAD_OUTPUT", raw.paused ? "Claude research stayed paused without writing notes" : "Claude returned no research notes");
  }
  // Still paused at the call or search cap: the partial notes are kept, but the writer is told.
  let text = parsed.text;
  if (raw.paused) {
    logger.warn("Research stopped early: call or search limit reached, using the partial notes", { calls: raw.calls, searches: raw.searches, maxSearches });
    text = `${text}\n\n${STOPPED_EARLY_NOTE}`;
  }
  return { text, sources: parsed.sources, searches: raw.searches, provider: "claude", model: raw.model, calls: raw.calls };
}

// --- Gemini ---

const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;
const isGoogleRedirect = (uri: string) => hostOf(uri) === "vertexaisearch.cloud.google.com";

/** Where a grounding redirect leads. Any failure keeps the redirect URL itself. */
async function resolveUri(uri: string, fetchFn: typeof fetch, signal: AbortSignal): Promise<string> {
  if (!isGoogleRedirect(uri)) return uri;
  try {
    const res = await fetchFn(uri, { redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(REDIRECT_TIMEOUT_MS)]) });
    void res.body?.cancel().catch(() => {});
    const location = res.headers.get("location");
    if (location) {
      const target = new URL(location, uri);
      if (target.protocol === "http:" || target.protocol === "https:") return target.href;
    }
  } catch {
    signal.throwIfAborted();
  }
  return uri;
}

/** End of a grounding segment as a character offset (the API counts UTF-8 bytes), or -1 when unknown. */
function segmentEnd(part: string, segment: gemini.GeminiSearchResult["supports"][number]): number {
  const bytes = Buffer.from(part, "utf8");
  const chars = (end: number) => bytes.subarray(0, Math.min(end, bytes.length)).toString("utf8").length;
  const start = chars(segment.start);
  const end = chars(segment.end);
  if (!segment.text) return segment.end > 0 ? end : -1;
  if (part.slice(start, end) === segment.text) return end;
  // The offsets do not fit the text: trust the quoted text.
  const at = part.indexOf(segment.text);
  return at >= 0 ? at + segment.text.length : segment.end > 0 ? end : -1;
}

export async function parseGeminiGrounding(grounding: gemini.GeminiSearchResult, fetchFn: typeof fetch, signal: AbortSignal): Promise<Parsed> {
  // Cited chunks first, in the order the text cites them, then the rest.
  const supports = [...grounding.supports].sort((a, b) => a.partIndex - b.partIndex || a.start - b.start);
  const order: number[] = [];
  const push = (index: number) => { if (grounding.chunks[index] && !order.includes(index)) order.push(index); };
  for (const support of supports) support.chunks.forEach(push);
  grounding.chunks.forEach((_, index) => push(index));
  const candidates = order.slice(0, MAX_RESOLVED);
  const urls = await Promise.all(candidates.map((index) => resolveUri(grounding.chunks[index]!.uri, fetchFn, signal)));

  const sources = new SourceList();
  const idOf = new Map<number, string>();
  const urlOf = new Map<number, string>();
  candidates.forEach((index, n) => {
    const chunk = grounding.chunks[index]!;
    const title = chunk.title.trim();
    // The title is usually the site's domain: that is the publisher. Else the real host, if known.
    const publisher = DOMAIN.test(title) ? title.replace(/^www\./i, "").toLowerCase() : isGoogleRedirect(urls[n]!) ? "" : hostOf(urls[n]!);
    const source = sources.add({ url: urls[n], title, publisher });
    if (source) { idOf.set(index, source.id); urlOf.set(index, urls[n]!); }
  });

  const marks = new Map<number, Map<number, string[]>>();
  for (const support of supports) {
    const ids: string[] = [];
    for (const index of support.chunks) {
      const id = idOf.get(index);
      if (!id) continue;
      if (!ids.includes(id)) ids.push(id);
      sources.add({ url: urlOf.get(index), cited_text: support.text });
    }
    const part = grounding.parts[support.partIndex];
    if (!ids.length || !part) continue;
    const at = segmentEnd(part, support);
    if (at < 0) continue;
    const inPart = marks.get(support.partIndex) ?? new Map<number, string[]>();
    const known = inPart.get(at) ?? [];
    inPart.set(at, [...known, ...ids.filter((id) => !known.includes(id))]);
    marks.set(support.partIndex, inPart);
  }
  const text = grounding.parts.map((part, partIndex) => {
    let out = part;
    // From the end, so earlier offsets stay valid.
    for (const [at, ids] of [...(marks.get(partIndex) ?? [])].sort((a, b) => b[0] - a[0])) {
      out = `${out.slice(0, at)}${ids.map((id) => `[${id}]`).join("")}${out.slice(at)}`;
    }
    return out;
  }).join("").trim();
  return { text, sources: sources.done(), errors: [] };
}

async function researchWithGemini(
  system: string, user: string, model: string, maxSearches: number, signal: AbortSignal, opts: ResearchOptions,
): Promise<ResearchResult> {
  const grounding = await gemini.searchWeb(system, user, model, { fetch: opts.fetch, signal, sleep: opts.sleep });
  const parsed = await parseGeminiGrounding(grounding, opts.fetch ?? fetch, signal);
  const searches = grounding.queries.length;
  // Gemini has no search cap: the prompt only asks. Searches are billed, so a breach is worth a line.
  if (searches > maxSearches) logger.warn("Gemini grounding used more searches than allowed", { searches, maxSearches });
  // calls: the real HTTP attempts, retries included (each one counts against the quota).
  return { text: parsed.text, sources: parsed.sources, searches, provider: "gemini", model, calls: grounding.calls };
}

// --- the verdict in the notes ---

// A verdict may follow a line of narration ("I searched ... "), and may sit inside markup ("**", "- ", "> ").
// (Markup = anything that is not a letter, a digit or a line break.)
const NO_STORY = /^[^\p{L}\p{N}\r\n]*NO QUALIFYING STORY/imu;
const NO_SOURCES = /^[^\p{L}\p{N}\r\n]*NO SOURCES FOUND/imu;
const STORY_BLOCK = /^[^\p{L}\p{N}\r\n]*STORY\s*\d+\s*:/imu;
// Topic and article notes (research.md) number their blocks "ANGLE n:" instead.
const ANGLE_BLOCK = /^[^\p{L}\p{N}\r\n]*ANGLE\s*\d+\s*:/imu;
// "Facts:" on its own line, then at least one bullet.
const FACT_LIST = /^[^\p{L}\p{N}\r\n]*Facts?\s*:[^\p{L}\p{N}\r\n]*\r?\n\s*[-*\u2022]\s*\S/imu;

export type ResearchVerdict = "ok" | "no_story" | "no_sources";

/**
 * Should the writer run at all? research.md has the model say so in its notes.
 * - News: "NO QUALIFYING STORY" (nothing passed the audit) or "NO SOURCES FOUND", at the start of any
 *   line, and only when no "STORY n:" block is there; a brief with stories is never stopped.
 * - Topic and article: only "NO SOURCES FOUND" counts, and only with no "STORY n:" or "ANGLE n:" block and
 *   no "Facts:" list.
 */
export function researchVerdict(text: string, sourceType: string | undefined): ResearchVerdict {
  if (sourceType === "news") {
    if (STORY_BLOCK.test(text)) return "ok";
    if (NO_STORY.test(text)) return "no_story";
    return NO_SOURCES.test(text) ? "no_sources" : "ok";
  }
  const content = STORY_BLOCK.test(text) || ANGLE_BLOCK.test(text) || FACT_LIST.test(text);
  return NO_SOURCES.test(text) && !content ? "no_sources" : "ok";
}
