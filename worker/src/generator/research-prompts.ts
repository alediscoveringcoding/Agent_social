// Prompts for the research step (amendment 07). The writer's prompts are in prompts.ts.
// The research call pays for its input tokens, so these stay short: the generic research
// rules, the brand's audience and topics and, for news requests only, the news audit and the
// selection and accuracy sections of the owner's briefs for the targeted platforms.
// A topic or article request gathers current facts and context with sources: no story filter.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  MAX_TOPICS, PROMPTS_DIR, addDays, loadContentTypes, loadPublicBrand, packKey, playbookKey, splitNews, targetsLinkedin, todayOf,
  type BrandProfile, type StylePack,
} from "./style-pack.js";

export interface ResearchRules {
  /** Search and accuracy rules, for every research request. */
  common: string;
  /** Window, selection with the news audit and the story notes format. */
  news: string;
  /** Selection without a story filter and the angle notes format. */
  topic: string;
  /** How facts are marked for citation. */
  markers: string;
}

/** prompts/style/research.md: a common part, then the `## News`, `## Topic and article` and `## Source markers` sections. */
export function parseResearchRules(text: string): ResearchRules {
  const parts = text.replace(/\r\n/g, "\n").split(/^## /m);
  const sections = new Map(parts.slice(1).map(part => {
    const [title, ...body] = part.split("\n");
    return [title.trim().toLowerCase(), body.join("\n").trim()] as const;
  }));
  const news = sections.get("news");
  const topic = sections.get("topic and article");
  const markers = sections.get("source markers");
  if (!news || !topic || !markers) throw new Error('prompts/style/research.md needs the sections "## News", "## Topic and article" and "## Source markers"');
  return { common: parts[0].trim(), news, topic, markers };
}

const researchRules = parseResearchRules(fs.readFileSync(path.join(PROMPTS_DIR, "style", "research.md"), "utf8"));
// Story types, what to leave out and the audit; the hooks and post bodies are the writer's business.
const newsTypes = splitNews(loadContentTypes().news);

/** Headings of an original brief that are sent to a news research call (accents and case ignored). */
export const EXCERPT_HEADINGS = /tipuri de stiri|story types|audit|selectie|selection|acuratete|accuracy|fapte|facts/;
/** Headings sent to a topic or article research call: accuracy only, the story selection is for news. */
export const ACCURACY_HEADINGS = /acuratete|accuracy|fapte|facts/;
/** At most this many characters of one original reach the research call. */
export const EXCERPT_MAX_CHARS = 7000;
export const MAX_STORIES = 10;
const MAX_PLATFORMS = 6;

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** The `##` sections of a brief whose heading names selection, audit or accuracy (accuracy only when `news` is false). */
export function pickSections(markdown: string, news = true): string {
  const wanted = news ? EXCERPT_HEADINGS : ACCURACY_HEADINGS;
  const picked = markdown.replace(/\r\n/g, "\n").split(/^(?=## )/m)
    .filter(part => part.startsWith("## ") && wanted.test(fold(part.split("\n", 1)[0])))
    .map(part => part.trim())
    .join("\n\n");
  if (picked.length <= EXCERPT_MAX_CHARS) return picked;
  const head = picked.slice(0, EXCERPT_MAX_CHARS);
  return head.slice(0, Math.max(head.lastIndexOf("\n"), 0) || EXCERPT_MAX_CHARS).trimEnd();
}

/** The brand's search themes, without repeats, cut at MAX_TOPICS (style-pack puts private ones first). */
function topicsOf(b: BrandProfile): string {
  const seen = new Set<string>();
  const topics = (b.news_topics ?? []).filter(t => {
    const key = t.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_TOPICS);
  return topics.length ? `BRAND TOPICS (search themes when no focus is given, tie-breakers otherwise):\n${topics.map(t => `- ${t}`).join("\n")}` : "";
}

/** System and user prompt for the web-search research call. */
export function buildResearchPrompts(
  brand: { slug: string; name: string },
  input: any,
  style?: StylePack,
): { system: string; user: string } {
  const b: BrandProfile = (style ? style.brand : loadPublicBrand(brand.slug)) ?? {};
  const name = b.name ?? brand.name;
  const source = input?.source ?? {};
  const isNews = source.type === "news";
  const platforms: string[] = Array.isArray(input?.platforms) ? input.platforms.filter((p: unknown) => typeof p === "string") : [];
  const keys = [...new Set(platforms.map(playbookKey))];
  const count = Math.min(Math.max(Math.floor(Number(input?.count)) || 3, 1), MAX_STORIES);

  // One excerpt per brief in use: a platform's own original first, then its playbook's.
  const briefKeys = [...new Set(platforms.flatMap(p => packKey(style?.originals, p) ?? []))];
  const excerpts = briefKeys.flatMap(key => {
    const text = pickSections(style!.originals[key], isNews);
    if (!text) return [];
    return [isNews
      ? `OWNER'S SELECTION AND ACCURACY RULES FOR ${key} (from the owner's brief; they add to the audit above and win where they differ):\n${text}`
      : `OWNER'S ACCURACY RULES FOR ${key} (from the owner's brief; they add to the rules above):\n${text}`];
  });
  // The audit is for news only; its LinkedIn-only criterion needs a LinkedIn target.
  const audit = [newsTypes.audit, targetsLinkedin(platforms) ? newsTypes.linkedinCriterion : ""].filter(Boolean).join("\n");
  const system = [
    researchRules.common,
    isNews ? researchRules.news : researchRules.topic,
    researchRules.markers,
    `BRAND: ${name}${b.summary ? `, ${b.summary.trim().replace(/\.$/, "")}` : ""}.\nAUDIENCE: ${b.audience ?? "readers of the brand's social accounts"}`,
    topicsOf(b),
    isNews ? `NEWS AUDIT (score every candidate story with it):\n${audit}` : "",
    ...excerpts,
  ].filter(Boolean).join("\n\n");

  const today = todayOf(input);
  const days = isNews ? Math.min(Math.max(Math.floor(Number(source.window_days)) || 7, 1), 30) : 0;
  const focus = typeof source.topic === "string" ? source.topic.trim() : "";
  const task = isNews
    // "The last N days" is N dates: today and the N-1 days before it.
    ? `Find up to ${count} stories whose event date falls from ${addDays(today, -(days - 1))} to ${today} (the last ${days} days)${focus ? `, about: ${focus}` : ", on the brand topics"}.`
    : source.type === "article"
      ? `Check the main claims of the article at ${source.url} against primary sources and add the context a reader needs. Up to ${count} angles, with sources for each fact.`
      : `Research this topic: ${focus || "(none given)"}. Report its current state and the latest developments, each with its date and source. Up to ${count} angles.`;
  const shown = keys.slice(0, MAX_PLATFORMS);
  const user = [
    task,
    `Today is ${today} (Europe/Bucharest).`,
    shown.length ? `Targeted platforms, one angle line each: ${shown.join(", ")}${keys.length > shown.length ? ` and ${keys.length - shown.length} more` : ""}.` : "",
    "Answer with the research notes in the format given.",
  ].filter(Boolean).join("\n");
  return { system, user };
}
