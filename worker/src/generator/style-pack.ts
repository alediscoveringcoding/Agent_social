import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "yaml";
import { z } from "zod";

export const PROMPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../prompts");
export const DEFAULT_STYLE_PACK_DIR = path.join(PROMPTS_DIR, "private");

export const CONTENT_TYPES = [
  "contrast-news", "tracker", "deadline-watch", "explainer", "tax-consequence", "myth-vs-fact", "enforcement-case", "brand-move",
] as const;

const lang = z.enum(["ro", "en"]);
const textMap = z.record(z.string(), z.string());

// Every key optional: a private file overrides only what it names.
const brandSchema = z.object({
  name: z.string().min(1),
  summary: z.string(),
  audience: z.string(),
  language: z.object({ default: lang, platforms: z.record(z.string(), lang), card: lang }).partial().strict(),
  voice: z.string(),
  content_types: z.array(z.enum(CONTENT_TYPES)),
  cta: textMap,
  hashtags: z.record(z.string(), z.array(z.string())),
  bullet: z.string(),
  emoji: z.enum(["none", "bullets-only", "light"]),
  avoid: z.array(z.string()),
  disclaimer: z.string(),
}).partial().strict();

export type BrandProfile = z.infer<typeof brandSchema>;

export interface StyleExample { file: string; content_type?: string; note?: string; text: string }
export interface StylePack {
  brand: BrandProfile | null;
  /** Brand notes appended after the public playbook, by playbook key (linkedin, instagram...). */
  platformNotes: Record<string, string>;
  /** Examples by playbook key, sorted by file name. */
  examples: Record<string, StyleExample[]>;
}

export const EXAMPLE_GUARD = "EXAMPLES (copy structure, rhythm and voice only; never reuse their facts, numbers, names, dates or sentences):";
export const EXAMPLES_PER_PLATFORM = 2;
export const EXAMPLES_BUDGET = 8000;

/** linkedin-page shares the linkedin playbook, notes and examples. */
export function playbookKey(platform: string): string {
  return platform === "linkedin-page" ? "linkedin" : platform;
}

function readYamlBrand(file: string): BrandProfile | null {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = yaml.parse(fs.readFileSync(file, "utf8"));
    return brandSchema.parse(parsed ?? {});
  } catch (err) {
    const detail = err instanceof z.ZodError
      ? err.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
      : err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid style file ${file}: ${detail}`);
  }
}

export function mergeBrand(base: BrandProfile | null, over: BrandProfile | null): BrandProfile | null {
  if (!base) return over;
  if (!over) return base;
  return {
    ...base, ...over,
    language: { ...base.language, ...over.language, platforms: { ...base.language?.platforms, ...over.language?.platforms } },
    cta: { ...base.cta, ...over.cta },
    hashtags: { ...base.hashtags, ...over.hashtags },
  };
}

/** The generic layer alone: prompts/brands/<slug>.yaml. */
export function loadPublicBrand(slug: string, publicDir = PROMPTS_DIR): BrandProfile | null {
  return readYamlBrand(path.join(publicDir, "brands", `${slug}.yaml`));
}

function parseExample(file: string): StyleExample {
  const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { file, text: raw.trim() };
  try {
    const meta = z.object({ content_type: z.enum(CONTENT_TYPES), note: z.string() }).partial().strict().parse(yaml.parse(m[1]) ?? {});
    return { file, ...meta, text: m[2].trim() };
  } catch (err) {
    const detail = err instanceof z.ZodError ? err.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") : String(err);
    throw new Error(`Invalid example front matter in ${file}: ${detail}`);
  }
}

const sortedFiles = (dir: string, ext: string): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(ext)).sort() : [];

/**
 * Load the public brand profile, merge the private one over it and read the
 * private notes and examples. A missing pack or brand folder means generic only;
 * an invalid file throws an error naming it.
 */
export function loadStylePack(slug: string, dir: string = DEFAULT_STYLE_PACK_DIR, publicDir = PROMPTS_DIR): StylePack {
  const publicBrand = loadPublicBrand(slug, publicDir);
  const root = path.join(dir, slug);
  if (!fs.existsSync(root)) return { brand: publicBrand, platformNotes: {}, examples: {} };
  const brand = mergeBrand(publicBrand, readYamlBrand(path.join(root, "brand.yaml")));
  const platformNotes: Record<string, string> = {};
  for (const f of sortedFiles(path.join(root, "platforms"), ".md")) {
    const text = fs.readFileSync(path.join(root, "platforms", f), "utf8").trim();
    if (text) platformNotes[f.slice(0, -3)] = text;
  }
  const examples: Record<string, StyleExample[]> = {};
  const exRoot = path.join(root, "examples");
  if (fs.existsSync(exRoot)) {
    for (const p of fs.readdirSync(exRoot).sort()) {
      if (!fs.statSync(path.join(exRoot, p)).isDirectory()) continue;
      const list = sortedFiles(path.join(exRoot, p), ".md").map(f => parseExample(path.join(exRoot, p, f))).filter(e => e.text);
      if (list.length) examples[p] = list;
    }
  }
  return { brand, platformNotes, examples };
}

/** At most 2 per targeted playbook, in request order; later files drop first once over budget. */
export function selectExamples(style: StylePack, platforms: readonly string[], budget = EXAMPLES_BUDGET): { platform: string; example: StyleExample }[] {
  const keys = [...new Set(platforms.map(playbookKey))];
  const picked = keys.flatMap(k => (style.examples[k] ?? []).slice(0, EXAMPLES_PER_PLATFORM).map(example => ({ platform: k, example })));
  const out: typeof picked = [];
  let used = 0;
  for (const item of picked) {
    if (used + item.example.text.length > budget) break;
    used += item.example.text.length;
    out.push(item);
  }
  return out;
}
