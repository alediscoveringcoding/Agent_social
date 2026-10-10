// Prompts for the research step (amendment 07). The writer's prompts are in prompts.ts.
// The research call pays for its input tokens, so these stay short: the generic research
// rules, the brand's audience and topics, the news audit, and only the selection and
// accuracy sections of the owner's briefs for the targeted platforms.
import * as fs from "node:fs";
import * as path from "node:path";
import { PROMPTS_DIR, loadContentTypes, loadPublicBrand, playbookKey, type BrandProfile, type StylePack } from "./style-pack.js";

const researchRules = fs.readFileSync(path.join(PROMPTS_DIR, "style", "research.md"), "utf8").trim();
// Story types, what to leave out and the audit; the hooks and post bodies are the writer's business.
const newsAudit = loadContentTypes().news.split(/\n(?=Hooks:)/)[0].trim();

/** `##` headings of an original brief that are also sent to the research call (accents and case ignored). */
export const EXCERPT_HEADINGS = /tipuri de stiri|story types|audit|selectie|selection|acuratete|accuracy|fapte|facts/;
/** At most this many characters of one original reach the research call. */
export const EXCERPT_MAX_CHARS = 7000;
export const MAX_STORIES = 10;
const MAX_TOPICS = 10;
const MAX_PLATFORMS = 6;
const DAY_MS = 86_400_000;

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** The `##` sections of a brief whose heading names selection, audit or accuracy. */
export function pickSections(markdown: string): string {
  const picked = markdown.replace(/\r\n/g, "\n").split(/^(?=## )/m)
    .filter(part => part.startsWith("## ") && EXCERPT_HEADINGS.test(fold(part.split("\n", 1)[0])))
    .map(part => part.trim())
    .join("\n\n");
  if (picked.length <= EXCERPT_MAX_CHARS) return picked;
  const head = picked.slice(0, EXCERPT_MAX_CHARS);
  return head.slice(0, Math.max(head.lastIndexOf("\n"), 0) || EXCERPT_MAX_CHARS).trimEnd();
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `input.today` (YYYY-MM-DD) pins the date for tests; otherwise the worker's clock. */
function todayOf(input: any): Date {
  const pinned = typeof input?.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.today) ? new Date(`${input.today}T00:00:00Z`) : null;
  return pinned && !Number.isNaN(pinned.getTime()) ? pinned : new Date();
}

function topicsOf(b: BrandProfile): string {
  const topics = (b.news_topics ?? []).slice(0, MAX_TOPICS);
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
  const platforms: string[] = Array.isArray(input?.platforms) ? input.platforms.filter((p: unknown) => typeof p === "string") : [];
  const keys = [...new Set(platforms.map(playbookKey))];
  const count = Math.min(Math.max(Math.floor(Number(input?.count)) || 3, 1), MAX_STORIES);

  const excerpts = keys.flatMap(key => {
    const text = style?.originals?.[key] ? pickSections(style.originals[key]) : "";
    return text ? [`OWNER'S SELECTION AND ACCURACY RULES FOR ${key} (from the owner's brief; they add to the audit above and win where they differ):\n${text}`] : [];
  });
  const system = [
    researchRules,
    `BRAND: ${name}${b.summary ? `, ${b.summary.trim().replace(/\.$/, "")}` : ""}.\nAUDIENCE: ${b.audience ?? "readers of the brand's social accounts"}`,
    topicsOf(b),
    `NEWS AUDIT (score every candidate story with it):\n${newsAudit}`,
    ...excerpts,
  ].filter(Boolean).join("\n\n");

  const today = todayOf(input);
  const days = source.type === "news" ? Math.min(Math.max(Math.floor(Number(source.window_days)) || 7, 1), 30) : 0;
  const focus = typeof source.topic === "string" ? source.topic.trim() : "";
  const task = source.type === "news"
    ? `Find up to ${count} stories whose event date falls from ${isoDay(new Date(today.getTime() - days * DAY_MS))} to ${isoDay(today)} (the last ${days} days)${focus ? `, about: ${focus}` : ", on the brand topics"}.`
    : source.type === "article"
      ? `Check the main claims of the article at ${source.url} against primary sources and add the context a reader needs. Up to ${count} stories or angles.`
      : `Research this topic: ${focus || "(none given)"}. Report its current state and the latest developments, each with its date. Up to ${count} stories or angles.`;
  const shown = keys.slice(0, MAX_PLATFORMS);
  const user = [
    task,
    `Today is ${isoDay(today)}.`,
    shown.length ? `Targeted platforms, one angle line each: ${shown.join(", ")}${keys.length > shown.length ? ` and ${keys.length - shown.length} more` : ""}.` : "",
    "Answer with the research notes in the format given.",
  ].filter(Boolean).join("\n");
  return { system, user };
}
