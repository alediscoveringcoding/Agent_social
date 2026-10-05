/**
 * Social publishing: the values both the contracts (PRD section 10) and the
 * admin screens agree on. Pure module: no Node or browser APIs, so the
 * composer, the server and the test runner all import it.
 */

export const PLATFORMS = [
  'facebook',
  'instagram',
  'linkedin-page',
  'x',
  'devto',
  'hashnode',
  'substack',
  'producthunt',
] as const
export type Platform = (typeof PLATFORMS)[number]

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value)
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  'linkedin-page': 'LinkedIn',
  x: 'X',
  devto: 'dev.to',
  hashnode: 'Hashnode',
  substack: 'Substack',
  producthunt: 'Product Hunt',
}

/** No publishing API (PRD section 5): always a manual handoff. */
export const MANUAL_ONLY_PLATFORMS: readonly Platform[] = ['substack', 'producthunt']

/** Content kind per platform (PRD section 5). */
export const PLATFORM_KIND: Record<Platform, PostKind> = {
  facebook: 'social',
  instagram: 'social',
  'linkedin-page': 'social',
  x: 'social',
  devto: 'article',
  hashnode: 'article',
  substack: 'article',
  producthunt: 'launch',
}

export const POST_KINDS = ['social', 'article', 'launch'] as const
export type PostKind = (typeof POST_KINDS)[number]

export const ACCOUNT_STATUSES = [
  'connected',
  'reconnect_required',
  'developer_setup_required',
  'approval_pending',
  'manual',
] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  connected: 'Conectat',
  reconnect_required: 'Trebuie reconectat',
  developer_setup_required: 'Lipsesc permisiuni',
  approval_pending: 'Asteapta aprobarea platformei',
  manual: 'Manual',
}

export const JOB_STATUSES = [
  'queued',
  'claimed',
  'submitting',
  'submitted',
  'reconciling',
  'published',
  'failed',
  'cancelled',
  'manual_pending',
  'manual_done',
] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Programat',
  claimed: 'Preluat de worker',
  submitting: 'Se trimite',
  submitted: 'Trimis, asteapta platforma',
  reconciling: 'Se verifica',
  published: 'Publicat',
  failed: 'Esuat',
  cancelled: 'Anulat',
  manual_pending: 'De publicat manual',
  manual_done: 'Publicat manual',
}

export const POST_STATUSES = [
  'draft',
  'approved',
  'publishing',
  'published',
  'partial',
  'failed',
  'cancelled',
] as const
export type PostStatus = (typeof POST_STATUSES)[number]

export const POST_STATUS_LABELS: Record<PostStatus, string> = {
  draft: 'Ciorna',
  approved: 'Aprobat',
  publishing: 'Se publica',
  published: 'Publicat',
  partial: 'Partial',
  failed: 'Esuat',
  cancelled: 'Anulat',
}

/** PRD 10.7. */
export const ERROR_CODES = [
  'RATE_LIMITED',
  'TRANSIENT',
  'MEDIA_FETCH_FAILED',
  'AUTH_EXPIRED',
  'PERMISSION_DENIED',
  'VALIDATION_REJECTED',
  'HASH_MISMATCH',
  'UNKNOWN_RESULT',
  'STALE',
  'RECONCILE_MISS',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export const ERROR_CODE_LABELS: Record<string, string> = {
  RATE_LIMITED: 'Limita de cereri a platformei',
  TRANSIENT: 'Eroare temporara (retea sau server)',
  MEDIA_FETCH_FAILED: 'Imaginea nu a putut fi descarcata',
  AUTH_EXPIRED: 'Conexiunea contului a expirat',
  PERMISSION_DENIED: 'Lipsesc permisiuni pe cont',
  VALIDATION_REJECTED: 'Platforma a refuzat continutul',
  HASH_MISMATCH: 'Continutul trimis difera de cel aprobat',
  UNKNOWN_RESULT: 'Rezultat incert, se verifica',
  STALE: 'Ora a trecut de mai mult de 2 ore',
  RECONCILE_MISS: 'Postarea nu a fost gasita la verificare',
  LEASE_EXPIRED: 'Workerul nu a raspuns la timp',
}

export const DELIVERY_OUTCOMES = ['published', 'failed', 'retry', 'reconciling', 'not_found'] as const
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number]

export const EVENT_TYPES = [
  'delivery_failed',
  'delivery_stale',
  'account_reconnect_required',
  'manual_due',
  'drafts_ready',
  'generation_failed',
  'foreign_post',
  'worker_silent',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const EVENT_LABELS: Record<EventType, string> = {
  delivery_failed: 'Publicare esuata',
  delivery_stale: 'Publicare expirata',
  account_reconnect_required: 'Cont de reconectat',
  manual_due: 'De publicat manual',
  drafts_ready: 'Ciorne noi',
  generation_failed: 'Generare esuata',
  foreign_post: 'Postare facuta direct in Postiz',
  worker_silent: 'Workerul nu mai raspunde',
}

/** Card formats the renderer produces (PRD 10.5). */
export const CARD_FORMATS = {
  square: { width: 1080, height: 1080 },
  portrait: { width: 1080, height: 1350 },
  x: { width: 1600, height: 900 },
  devto_cover: { width: 1000, height: 420 },
  hashnode_cover: { width: 1600, height: 840 },
  ph_gallery: { width: 1270, height: 760 },
} as const
export type CardFormat = keyof typeof CARD_FORMATS
export const CARD_FORMAT_NAMES = Object.keys(CARD_FORMATS) as CardFormat[]

export function isCardFormat(value: unknown): value is CardFormat {
  return typeof value === 'string' && value in CARD_FORMATS
}

/** Which format each destination gets (PRD 10.5 table). */
export const PLATFORM_CARD_FORMAT: Record<Platform, CardFormat> = {
  facebook: 'square',
  'linkedin-page': 'square',
  instagram: 'portrait',
  x: 'x',
  devto: 'devto_cover',
  hashnode: 'hashnode_cover',
  substack: 'hashnode_cover',
  producthunt: 'ph_gallery',
}

/**
 * AI models the admin can pick per generation request (stored as input.ai).
 * No pick = the worker's default from its .env. The worker needs the matching
 * key (ANTHROPIC_API_KEY / GEMINI_API_KEY); without it the request fails with
 * AI_NOT_CONFIGURED and says so in "Cereri recente".
 */
export const AI_PROVIDERS = ['claude', 'gemini'] as const
export type AiProvider = (typeof AI_PROVIDERS)[number]

export const AI_MODELS = [
  { id: 'gemini-3.8-flash', provider: 'gemini', label: 'Gemini 3.8 Flash' },
  { id: 'gemini-3.7-flash', provider: 'gemini', label: 'Gemini 3.7 Flash (cota gratuita separata)' },
  { id: 'claude-opus-5-5', provider: 'claude', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', provider: 'claude', label: 'Claude Sonnet 5.5' },
] as const satisfies ReadonlyArray<{ id: string; provider: AiProvider; label: string }>
export type AiModelId = (typeof AI_MODELS)[number]['id']

export const CARD_TEMPLATES = ['light', 'dark', 'mint'] as const
export type CardTemplate = (typeof CARD_TEMPLATES)[number]

export const CARD_TEMPLATE_LABELS: Record<CardTemplate, string> = {
  light: 'Light',
  dark: 'Dark',
  mint: 'Mint',
}

export const SOCIAL_TIMEZONE = 'Europe/Bucharest'

/** PRD D8: default and maximum. An admin can lower it per account. */
export const MAX_DAILY_CAP = 5

/** Uploads (F3). */
export const MEDIA_MAX_BYTES = 8 * 1024 * 1024
export const MEDIA_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type MediaMime = (typeof MEDIA_MIME_TYPES)[number]

export const SOCIAL_BUCKET = 'social-media'

/** Postiz provider identifiers (with the spellings seen in v2.25.0) to our platforms. */
export const PROVIDER_TO_PLATFORM: Record<string, Platform> = {
  x: 'x',
  facebook: 'facebook',
  instagram: 'instagram',
  'instagram-standalone': 'instagram',
  'instagram.standalone': 'instagram',
  'linkedin-page': 'linkedin-page',
  'linkedin.page': 'linkedin-page',
  devto: 'devto',
  'dev.to': 'devto',
  hashnode: 'hashnode',
}

/** Where the "Open editor" link of a manual destination points by default. */
export const DEFAULT_OPEN_EDITOR_URLS: Partial<Record<Platform, string>> = {
  substack: 'https://substack.com/',
  producthunt: 'https://www.producthunt.com/posts/new',
  'linkedin-page': 'https://www.linkedin.com/feed/',
  facebook: 'https://www.facebook.com/',
  x: 'https://x.com/compose/post',
  devto: 'https://dev.to/new',
  hashnode: 'https://hashnode.com/draft',
}
