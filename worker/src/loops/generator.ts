import { config } from "../config.js";
import { logger } from "../logger.js";
import { LeaseLostError, isAmbiguousSiteError, isTransportError, siteApi } from "../services/site-api.js";
import { AiNotConfiguredError, generateDrafts, resolveChoice } from "../services/llm.js";
import { AiOutputError } from "../services/ai-errors.js";
import { isOurBlogUrl } from "../generator/content-rules.js";
import { DEVTO_MAX_TAGS, HASHNODE_MAX_TAGS, MEDIUM_MAX_TAGS, MEDIUM_TAG_MAX, PH_TAGLINE_MAX, validateContent, validateLinksFromSearch, validateVariantFields, type ValidationError } from "../generator/validators.js";
import { variantSettings } from "../generator/variant-settings.js";
import { kindOf } from "../platforms.js";
import { normalizeFigure, unlistedFigures, type DraftFigure } from "../generator/figures.js";
import { activeFacts, buildSystemPrompt, buildUserPrompt, brandFromSlug } from "../generator/prompts.js";
import { buildResearchPrompts } from "../generator/research-prompts.js";
import { researchVerdict, runResearch, type ResearchRunner } from "../generator/research.js";
import { wantsResearch, type ResearchBrief } from "../generator/research-types.js";
import { addReviewerNotes, allowedLinkKeys, factFigures, loadFacts, mapDraftSources } from "../generator/source-map.js";
import { DEFAULT_STYLE_PACK_DIR, loadStylePack, todayOf } from "../generator/style-pack.js";
import { buildRepairPrompt, mergeRepairs } from "../generator/repair.js";
import { boundDraftForSite } from "../generator/wire-bounds.js";

/** Article platforms whose post needs a canonical URL on our blog. */
const CANONICAL_PLATFORMS = ["devto", "hashnode", "medium"];

export function startGeneratorLoop() {
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const { requests } = await siteApi.claimGeneration();
      for (const req of requests ?? []) await processGenerationRequest(req);
    } catch (err) {
      logger.error("Generator loop error", { error: String(err) });
    } finally { running = false; }
  }
  const timer = setInterval(tick, config.GENERATION_LOOP_INTERVAL_MS);
  void tick();
  return () => clearInterval(timer);
}

/** Figures of the verified facts the writer was given (those valid today, or on input.today). */
const verifiedFactFigures = (input: any): string[] => factFigures(activeFacts(loadFacts(), todayOf(input)));

/** `facts`: the verified figures of a research request; tests pass their own. */
export function validateDraft(draft: any, i: number, brandSlug: string, input: any = {}, research?: ResearchBrief, facts?: readonly string[]): {
  client_ref: string; figures: DraftFigure[]; validation_errors: ValidationError[]; [key: string]: any;
} {
  const errors: ValidationError[] = [];
  const articleUrl: string | undefined = input.source?.type === "article" && typeof input.source.url === "string" ? input.source.url : undefined;
  // devto, hashnode and medium need a canonical URL on our blog, which only an article request has.
  // Drop them up front (with a note) rather than fail CANONICAL_MISSING after a paid repair.
  const sourceType = input.source?.type;
  if (sourceType && sourceType !== "article" && Array.isArray(draft.variants)) {
    const kept = draft.variants.filter((v: any) => !CANONICAL_PLATFORMS.includes(String(v?.platform).toLowerCase()));
    if (kept.length < draft.variants.length) {
      const dropped = [...new Set(draft.variants.filter((v: any) => !kept.includes(v)).map((v: any) => String(v.platform).toLowerCase()))];
      draft = addReviewerNotes({ ...draft, variants: kept }, [`Variantele ${dropped.join(", ")} au fost scoase: au nevoie de URL canonic pe blogul nostru, iar cererea nu porneste de la un articol.`]);
    }
  }
  // Source ids become the URLs the search found (amendment 07), then the wire limits apply to them.
  const researching = wantsResearch(input);
  const mapped = mapDraftSources(draft, research, researching, { articleUrl, facts: researching ? facts ?? verifiedFactFigures(input) : [] });
  errors.push(...mapped.errors);
  draft = boundDraftForSite(mapped.draft, errors);
  const allowedLinks = researching ? allowedLinkKeys(research, articleUrl) : undefined;
  const sourceUrl = draft.source_url || articleUrl || null;
  // title and link are model-side helpers; the site gets them as settings.
  const variants = (draft.variants ?? []).map(({ title, link, ...v }: any) => {
    const platform = String(v.platform).toLowerCase();
    return { ...v, platform, settings: variantSettings(platform, { title, link }, sourceUrl) };
  });
  const variantFields = (draft.variants ?? []).map((v: any) => ({ platform: String(v.platform).toLowerCase(), title: v.title, link: v.link }));
  const article = draft.article ? {
    ...draft.article,
    subtitle: draft.article.subtitle || null,
    canonical_url: draft.article.canonical_url || (input.source?.type === "article" ? input.source.url : null),
  } : null;
  const launch = draft.launch ? { ...draft.launch, maker_comment: draft.launch.maker_comment || null } : null;
  const card = { ...draft.card, template: String(draft.card?.template ?? "dark").toLowerCase(), brand: brandSlug, stat: draft.card?.stat || null };
  const texts = [draft.title, draft.canonical_text, article?.title, article?.subtitle, article?.body_markdown, ...(article?.tags ?? []), launch?.name, launch?.tagline, launch?.description, launch?.maker_comment, card.headline, card.keyword, card.stat, card.subline, card.alt_text].filter(Boolean);
  for (const text of texts) errors.push(...validateContent(text, "generic"));
  for (const v of variants) {
    const actual = v.text || (v.platform === "producthunt" ? launch?.description : kindOf(v.platform) === "article" ? article?.body_markdown : "") || "";
    texts.push(actual);
    errors.push(...validateContent(actual, v.platform).map(e => ({ ...e, field: `variants.${v.platform}` })));
    if (allowedLinks) errors.push(...validateLinksFromSearch(actual, allowedLinks).map(e => ({ ...e, field: `variants.${v.platform}` })));
  }
  for (const v of variantFields) {
    errors.push(...validateVariantFields(v.platform, v));
    for (const extra of [v.title, v.link]) {
      if (typeof extra === "string" && extra.trim()) {
        texts.push(extra);
        errors.push(...validateContent(extra, "generic").map(e => ({ ...e, field: `variants.${v.platform}` })));
      }
    }
  }
  const add = (rule: string, message: string, field: string) => errors.push({ rule, message, field });
  const platforms = new Set<string>(variants.map((v: any) => v.platform));
  const tagList: string[] = article?.tags ?? [];
  if (platforms.has("medium")) {
    if (!article?.subtitle?.trim()) add("medium_subtitle", "Medium needs a subtitle", "article.subtitle");
    if (tagList.length > MEDIUM_MAX_TAGS || tagList.some(t => Array.from(t).length > MEDIUM_TAG_MAX)) {
      add("article_tags_medium", `Medium takes at most ${MEDIUM_MAX_TAGS} tags of at most ${MEDIUM_TAG_MAX} characters`, "article.tags");
    }
  }
  // The rules below use the site's codes and limits (validateDestination).
  for (const [platform, max] of [["devto", DEVTO_MAX_TAGS], ["hashnode", HASHNODE_MAX_TAGS]] as const) {
    if (platforms.has(platform) && tagList.length > max) add("TOO_MANY_TAGS", `${platform} takes at most ${max} tags (got ${tagList.length})`, "article.tags");
  }
  for (const v of variants) {
    const actual = v.text || (v.platform === "producthunt" ? launch?.description : kindOf(v.platform) === "article" ? article?.body_markdown : "") || "";
    if (!String(actual).trim()) add("EMPTY_TEXT", `The text for ${v.platform} is empty`, `variants.${v.platform}`);
  }
  if ([...platforms].some(p => kindOf(p) === "article") && !article?.title?.trim()) add("TITLE_MISSING", "Article platforms need article.title", "article.title");
  if (platforms.has("producthunt")) {
    if (!launch?.name?.trim()) add("PH_NAME_MISSING", "Product Hunt needs launch.name", "launch.name");
    const tagline: string = launch?.tagline ?? "";
    if (!tagline.trim()) add("PH_TAGLINE_MISSING", "Product Hunt needs launch.tagline", "launch.tagline");
    else if (Array.from(tagline).length > PH_TAGLINE_MAX) add("PH_TAGLINE_TOO_LONG", `Tagline has ${Array.from(tagline).length} of ${PH_TAGLINE_MAX} characters`, "launch.tagline");
  }
  for (const platform of CANONICAL_PLATFORMS) {
    if (!platforms.has(platform)) continue;
    const canonical: string | undefined = article?.canonical_url;
    if (!canonical?.trim()) add("CANONICAL_MISSING", `${platform} needs article.canonical_url on our blog`, "article.canonical_url");
    else if (!isOurBlogUrl(canonical)) add("CANONICAL_NOT_OURS", `${platform} canonical_url must be https on thecrypto.support or taxes.support`, "article.canonical_url");
  }
  for (const [field, limit] of [["headline", 70], ["stat", 8], ["subline", 110]] as const) {
    if (Array.from(card[field] ?? "").length > limit) add("card_length", `${field} exceeds ${limit} characters`, `card.${field}`);
  }
  // The site: only a non-empty keyword is checked, case-sensitive.
  if (card.keyword && !String(card.headline ?? "").includes(card.keyword)) add("card_keyword", "Keyword must occur in headline", "card.keyword");
  if (!card.alt_text?.trim()) add("card_alt", "Card needs accessible alt text", "card.alt_text");

  // Preserve model provenance, preferring a sourced value over unverified.
  const listed = new Map<string, DraftFigure>();
  for (const figure of draft.figures ?? []) {
    const key = normalizeFigure(figure.value);
    const existing = listed.get(key);
    if (!existing || existing.source === "unverified" && figure.source !== "unverified") listed.set(key, figure);
  }
  const allText = texts.join(" ");
  for (const figure of unlistedFigures(allText, [...listed.values()])) {
    const key = normalizeFigure(figure.value);
    if (!listed.has(key)) listed.set(key, { value: figure.value, source: "unverified", context: allText.slice(Math.max(0, figure.index - 20), figure.index + figure.value.length + 20).trim() });
  }
  return {
    ...draft, client_ref: draft.client_ref || String(i + 1),
    title: draft.title || null, source_url: draft.source_url || null, notes: draft.notes || null,
    article, launch, card, variants,
    figures: [...listed.values()].slice(0, 500), validation_errors: errors.slice(0, 500),
  };
}

interface GenerationRequest { request_id: string; brand: string; input: any; lease_expires_at: string }
type GenerationApi = Pick<typeof siteApi, "generationHeartbeat" | "postDrafts" | "generationFailed">;

export async function processGenerationRequest(req: GenerationRequest, deps: {
  api?: GenerationApi; generate?: typeof generateDrafts; research?: ResearchRunner; heartbeatMs?: number; repair?: boolean;
} = {}) {
  const { request_id, brand: brandSlug, input } = req;
  const api = deps.api ?? siteApi;
  const generate = deps.generate ?? generateDrafts;
  const research = deps.research ?? runResearch;
  const controller = new AbortController();
  let expires = new Date(req.lease_expires_at).getTime();
  let finished = false;
  let posting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const armExpiry = () => {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => controller.abort(new LeaseLostError()), Math.max(1, expires - Date.now()));
  };
  const lost = (err: unknown) => err instanceof LeaseLostError || err instanceof Error && err.message === "LEASE_LOST";
  const checkLease = () => {
    controller.signal.throwIfAborted();
    if (!Number.isFinite(expires) || expires <= Date.now()) {
      controller.abort(new LeaseLostError());
      controller.signal.throwIfAborted();
    }
  };
  const schedule = () => {
    if (finished || controller.signal.aborted) return;
    const remaining = expires - Date.now();
    if (remaining <= 0) { controller.abort(new LeaseLostError()); return; }
    timer = setTimeout(async () => {
      try {
        const result = await api.generationHeartbeat(request_id, { signal: controller.signal });
        const next = Date.parse(result.lease_expires_at);
        if (!Number.isFinite(next)) throw new Error("Invalid generation lease response");
        expires = next;
        armExpiry();
      } catch (err) {
        if (finished) return;
        if (lost(err)) { controller.abort(new LeaseLostError()); return; }
        logger.warn("Generation heartbeat failed", { requestId: request_id, error: String(err) });
      }
      schedule();
    }, Math.max(1, Math.min(deps.heartbeatMs ?? config.GENERATION_HEARTBEAT_MS, remaining / 3)));
  };
  try {
    checkLease();
    armExpiry();
    schedule();
    const brand = brandFromSlug(brandSlug);
    const choice = resolveChoice(input?.ai);
    const style = loadStylePack(brandSlug, config.STYLE_PACK_DIR ?? DEFAULT_STYLE_PACK_DIR);
    // Opt-in web research first (amendment 07): 1 extra AI call plus the searches, under the same
    // lease, heartbeat and abort handling as the writer. No sources, no writer call.
    let brief: ResearchBrief | undefined;
    if (wantsResearch(input)) {
      const prompts = buildResearchPrompts(brand, input, style);
      const found = await research(prompts.system, prompts.user, choice, { signal: controller.signal, maxSearches: config.RESEARCH_MAX_SEARCHES, timeoutMs: config.RESEARCH_TIMEOUT_MS });
      checkLease();
      brief = found;
      logger.info("Research done", { requestId: request_id, provider: found.provider, model: found.model, searches: found.searches, calls: found.calls ?? 1, sources: found.sources.length });
      if (found.sources.length === 0) {
        throw new AiOutputError("RESEARCH_EMPTY", `The web search found no sources (${found.searches} searches), so nothing was written`);
      }
      // research.md: nothing passed the audit, or (topic and article research) nothing was found.
      // The verdict may follow a line of narration. Skip the paid writer call and show the notes.
      const verdict = researchVerdict(found.text, input?.source?.type);
      if (verdict === "no_story") {
        throw new AiOutputError("RESEARCH_NO_STORY", `No story passed the audit, so nothing was written. ${found.text.trim().slice(0, 1500)}`);
      }
      if (verdict === "no_sources") {
        throw new AiOutputError("RESEARCH_EMPTY", `The research found nothing to write from, so nothing was written. ${found.text.trim().slice(0, 1500)}`);
      }
    }
    const system = buildSystemPrompt(brand, input, style);
    const { drafts } = await generate(system, buildUserPrompt(input, brief), choice, { signal: controller.signal });
    checkLease();
    const validated = drafts.map((d, i) => validateDraft(d, i, brandSlug, input, brief));
    let finalDrafts = validated;
    if ((deps.repair ?? config.GENERATION_REPAIR) && validated.some(d => d.validation_errors.length > 0)) {
      try {
        const repaired = await generate(system, buildRepairPrompt(validated, brief), choice, { signal: controller.signal });
        checkLease();
        finalDrafts = mergeRepairs(validated, repaired.drafts.map((d, i) => validateDraft(d, i, brandSlug, input, brief)));
      } catch (err) {
        checkLease();
        logger.warn("Repair failed, keeping original drafts", { requestId: request_id, error: String(err) });
      }
    }
    checkLease();
    let result;
    posting = true;
    try { result = await api.postDrafts(request_id, finalDrafts, { signal: controller.signal }); }
    catch (err) {
      if (lost(err) || controller.signal.aborted || !isTransportError(err)) throw err;
      // Timeout or dropped connection: the site may have stored the drafts. Re-posting is
      // idempotent (client_ref), so retry once with the same body and no new AI call.
      logger.warn("Posting drafts failed, retrying once", { requestId: request_id, error: String(err) });
      checkLease();
      result = await api.postDrafts(request_id, finalDrafts, { signal: controller.signal });
    }
    logger.info("Drafts posted", { requestId: request_id, created: result.created, skipped: result.skipped });
  } catch (err) {
    if (lost(err) || controller.signal.aborted || expires <= Date.now()) {
      logger.warn("Generation lease lost, stopping", { requestId: request_id });
      return;
    }
    // The drafts may already exist. Report the failure anyway: staying silent would let the lease
    // run out and a re-claim would pay for a new AI call. If the drafts were stored, the request is
    // already done and the site refuses this report.
    const uncertain = posting && isAmbiguousSiteError(err);
    if (uncertain) logger.error("Posting drafts may have succeeded", { requestId: request_id, error: String(err) });
    const code = uncertain ? "DRAFTS_POST_UNCERTAIN"
      : err instanceof AiNotConfiguredError || err instanceof AiOutputError ? err.code : "GENERATION_ERROR";
    try { await api.generationFailed(request_id, code, String(err), { signal: controller.signal }); }
    catch (reportErr) { if (!lost(reportErr) && !controller.signal.aborted) throw reportErr; }
  } finally {
    finished = true;
    clearTimeout(timer);
    clearTimeout(expiryTimer);
    controller.abort();
  }
}
