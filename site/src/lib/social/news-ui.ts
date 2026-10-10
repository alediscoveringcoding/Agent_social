/**
 * Pure helpers behind the amendment 07 screens: the Genereaza form and its
 * server action, the sources panel and the automation card. No React, no
 * Node-only APIs, so the browser, the server and the test runner share them.
 * Copy is Romanian without diacritics.
 */

import {
  AI_MODELS,
  AUTOMATION_STATUS_LABELS,
  AUTOMATION_WORKFLOW_LABELS,
  NEWS_WINDOW_DAYS,
  PLATFORM_KIND,
  SOURCES_APPROVAL_BLOCKED_HINT,
  type AutomationStatus,
  type CardTemplate,
  type GenerationSourceType,
  type Platform,
} from './constants.ts'
import { isHttpUrl } from './schemas.ts'

// ---------------------------------------------------------------------------
// Generation form and request
// ---------------------------------------------------------------------------

export type GenerationSourceValues =
  | { type: 'article'; url: string }
  | { type: 'topic'; topic: string; hooks: string[] }
  | { type: 'news'; topic: string; window_days: number }

/** What the Genereaza form hands to the createGenerationRequest action. */
export interface GenerationFormValues {
  brandId: string
  source: GenerationSourceValues
  /** Search the web before writing. A topic opts in; news always does; an article never. */
  research?: boolean
  platforms: Platform[]
  count: number
  templates: CardTemplate[]
  /** An AI_MODELS id; empty or absent = the worker's default. */
  aiModel?: string
}

/** Research is implicit for news, opt-in for a topic and off for an article. */
export function effectiveResearch(sourceType: string | undefined, requested: boolean | undefined): boolean {
  if (sourceType === 'news') return true
  if (sourceType === 'topic') return requested === true
  return false
}

/** "termen, schimbare de cota" to a list. */
export function parseHooks(raw: string): string[] {
  return raw
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
}

/** The "Perioada" field as whole days in 1..30; blank or junk falls back to the default. */
export function parseWindowDays(raw: string | number | null | undefined): number {
  const text = typeof raw === 'number' ? String(raw) : (raw ?? '').trim()
  if (text === '') return NEWS_WINDOW_DAYS.default
  const n = Number(text)
  if (!Number.isFinite(n)) return NEWS_WINDOW_DAYS.default
  return Math.min(NEWS_WINDOW_DAYS.max, Math.max(NEWS_WINDOW_DAYS.min, Math.round(n)))
}

/** The raw state of the Genereaza form. */
export interface GenerationFormState {
  brandId: string
  mode: GenerationSourceType
  url: string
  topic: string
  hooks: string
  /** The optional focus of a news search. */
  focus: string
  windowDays: string
  webSearch: boolean
  platforms: Platform[]
  count: number
  templates: CardTemplate[]
  aiModel: string
}

export function buildGenerationForm(s: GenerationFormState): GenerationFormValues {
  const source: GenerationSourceValues =
    s.mode === 'article'
      ? { type: 'article', url: s.url.trim() }
      : s.mode === 'news'
        ? { type: 'news', topic: s.focus.trim(), window_days: parseWindowDays(s.windowDays) }
        : { type: 'topic', topic: s.topic.trim(), hooks: parseHooks(s.hooks) }
  return {
    brandId: s.brandId,
    source,
    research: effectiveResearch(s.mode, s.webSearch),
    platforms: s.platforms,
    count: s.count,
    templates: s.templates,
    aiModel: s.aiModel,
  }
}

function normalizeSource(source: unknown): unknown {
  if (!source || typeof source !== 'object') return source
  const s = source as Record<string, unknown>
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  switch (s.type) {
    case 'article':
      return { type: 'article', url: text(s.url) }
    case 'topic':
      return {
        type: 'topic',
        topic: text(s.topic),
        hooks: Array.isArray(s.hooks) ? s.hooks.map(text).filter(Boolean) : [],
      }
    case 'news':
      return {
        type: 'news',
        topic: text(s.topic),
        window_days: s.window_days == null ? NEWS_WINDOW_DAYS.default : Number(s.window_days),
      }
    default:
      return source
  }
}

/**
 * The object the action validates with GenerationInputSchema. The form comes
 * from the browser, so every field is treated as untrusted here.
 */
export function buildGenerationCandidate(
  form: GenerationFormValues
): { ok: true; candidate: Record<string, unknown> } | { ok: false; error: string } {
  const platforms = [...new Set(form.platforms ?? [])]
  const kinds = [...new Set(platforms.map((p) => PLATFORM_KIND[p]).filter(Boolean))]
  const model = form.aiModel ? AI_MODELS.find((m) => m.id === form.aiModel) : undefined
  if (form.aiModel && !model) return { ok: false, error: 'Alege un model AI din lista.' }
  const source = normalizeSource(form.source)
  const sourceType = (source as { type?: string } | null | undefined)?.type
  return {
    ok: true,
    candidate: {
      ...(model ? { ai: { provider: model.provider, model: model.id } } : {}),
      source,
      research: effectiveResearch(sourceType, form.research),
      platforms,
      kinds,
      count: Number(form.count),
      language: 'ro',
      templates: form.templates?.length ? form.templates : ['dark', 'light', 'mint'],
    },
  }
}

/** A readable message for the first schema issue of a generation request. */
export function generationIssueMessage(path: string, sourceType: string | undefined): string {
  switch (path) {
    case 'source.url':
      return 'Linkul articolului trebuie sa inceapa cu https://.'
    case 'source.topic':
      return sourceType === 'news'
        ? 'Subiectul poate avea cel mult 500 de caractere.'
        : 'Descrie subiectul in cel putin 3 caractere.'
    case 'source.window_days':
      return `Perioada e un numar intreg de zile, intre ${NEWS_WINDOW_DAYS.min} si ${NEWS_WINDOW_DAYS.max}.`
    case 'platforms':
      return 'Alege cel putin o platforma.'
    case 'count':
      return 'Numarul de ciorne e intre 1 si 20.'
    default:
      return `Date invalide (${path || 'formular'}).`
  }
}

/** The source of a stored request, as the structure the list screen reads. */
export interface RequestSourceLike {
  type?: string
  url?: string
  topic?: string
  window_days?: number
}

export function requestSourceLabel(source: RequestSourceLike | null | undefined): string {
  if (!source) return '-'
  if (source.type === 'article') return source.url || '-'
  if (source.type === 'topic') return source.topic || '-'
  if (source.type === 'news') return source.topic ? `Stiri recente: ${source.topic}` : 'Stiri recente (temele brandului)'
  return '-'
}

export function requestUsesResearch(input: { source?: { type?: string }; research?: boolean } | null | undefined): boolean {
  return input?.source?.type === 'news' || input?.research === true
}

// ---------------------------------------------------------------------------
// Sources of a post
// ---------------------------------------------------------------------------

/** The part of a post source the panel reads (the real PostSource fits it). */
export interface SourceLike {
  id: string
  url: string
  title?: string | null
  publisher?: string | null
  published_at?: string | null
  note?: string | null
  found_in_search?: boolean | null
  verified_at?: string | null
  verified_by?: string | null
}

export function isSafeSourceUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && isHttpUrl(url)
}

export function sourceHost(url: string | null | undefined): string {
  if (!isSafeSourceUrl(url)) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const oneLine = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, ' ').trim()

/** What the link says: the title, else the publisher, else the site. */
export function sourceTitle(s: SourceLike): string {
  return oneLine(s.title) || oneLine(s.publisher) || sourceHost(s.url) || 'Sursa fara titlu'
}

/** "Publicatie · site · data", whatever of it is known. */
export function sourceMeta(s: SourceLike): string {
  return [oneLine(s.publisher), sourceHost(s.url), oneLine(s.published_at)].filter(Boolean).join(' · ')
}

/** The verifier as text; a bare id (a uuid) says nothing to a person, so it is not shown. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function verifierName(by: string | null | undefined): string | null {
  const name = oneLine(by)
  return name && !UUID.test(name) ? name : null
}

/** One optimistic click: the wanted value and the server value it was made against. */
export interface OptimisticVerify {
  value: boolean
  base: boolean
}

/**
 * The checkbox value to show. The optimistic value holds only while the
 * server still shows what the click started from; once a refresh brings a
 * different value, the server wins.
 */
export function effectiveVerified(serverVerified: boolean, pending: OptimisticVerify | undefined): boolean {
  return pending && pending.base === serverVerified ? pending.value : serverVerified
}

export function sourcesProgress(
  sources: ReadonlyArray<SourceLike>,
  pending: Readonly<Record<string, OptimisticVerify>> = {}
): { verified: number; total: number; unverified: number } {
  const total = sources.length
  const verified = sources.filter((s) => effectiveVerified(Boolean(s.verified_at), pending[s.id])).length
  return { verified, total, unverified: total - verified }
}

export function sourcesHeader(verified: number, total: number): string {
  return `${verified} din ${total} verificate`
}

/** The warning above the list, or null when every source is ticked. */
export function approvalBlockedHint(unverified: number): string | null {
  return unverified > 0 ? SOURCES_APPROVAL_BLOCKED_HINT : null
}

/** After approval the sources are frozen; a draft (or a cancelled post) can still change them. */
export function sourcesLocked(status: string): boolean {
  return status !== 'draft' && status !== 'cancelled'
}

/** The plain list for the LinkedIn first comment. Links that are not http(s) are left out. */
export function formatSourcesForComment(sources: ReadonlyArray<SourceLike>): string {
  const lines = sources
    .filter((s) => isSafeSourceUrl(s.url))
    .map((s) => {
      const title = oneLine(s.title) || sourceHost(s.url)
      const publisher = oneLine(s.publisher)
      return `- ${title}${publisher ? ` (${publisher})` : ''}: ${s.url.trim()}`
    })
  return lines.length ? ['Surse:', ...lines].join('\n') : ''
}

/** The link next to a figure that came from the web, or null. */
export function figureSourceUrl(figure: unknown): string | null {
  const url = (figure as { source_url?: unknown } | null | undefined)?.source_url
  return typeof url === 'string' && isHttpUrl(url.trim()) ? url.trim() : null
}

// ---------------------------------------------------------------------------
// Automation runs (n8n)
// ---------------------------------------------------------------------------

/** The part of a social_automation_runs row the card reads. */
export interface AutomationRunLike {
  id: number | string
  workflow: string
  status: string
  details?: unknown
  created_at: string
  /** The last report; the list is ordered by it. */
  updated_at?: string | null
}

/** When the run was last reported (an n8n retry updates the same row). */
export function automationRunTime(run: AutomationRunLike): string {
  return run.updated_at || run.created_at
}

export function automationStatusLabel(status: string): string {
  return AUTOMATION_STATUS_LABELS[status as AutomationStatus] ?? status
}

export function automationStatusTone(status: string): 'accent' | 'danger' | 'neutral' {
  return status === 'ok' ? 'accent' : status === 'error' ? 'danger' : 'neutral'
}

export function automationWorkflowLabel(workflow: string): string {
  return AUTOMATION_WORKFLOW_LABELS[workflow] ?? workflow
}

const DETAIL_TEXT_KEYS = ['message', 'error', 'reason', 'summary', 'note'] as const

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...` : text
}

/**
 * One short line for a run's details: its message when it has one, else up to
 * three plain fields ("brand: x · cereri: 2"). Nested values are not unpacked.
 */
export function summarizeRunDetails(details: unknown, max = 120): string {
  if (details == null) return ''
  if (typeof details === 'string') return clip(oneLine(details), max)
  if (typeof details === 'number' || typeof details === 'boolean') return String(details)
  if (Array.isArray(details)) return details.length ? `${details.length} elemente` : ''
  if (typeof details !== 'object') return ''
  const record = details as Record<string, unknown>
  for (const key of DETAIL_TEXT_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && oneLine(value)) return clip(oneLine(value), max)
  }
  const parts: string[] = []
  for (const [key, value] of Object.entries(record)) {
    if (parts.length >= 3) break
    if (typeof value === 'string' && oneLine(value)) parts.push(`${key}: ${oneLine(value)}`)
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${key}: ${value}`)
  }
  return clip(parts.join(' · '), max)
}
