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
  // Amendment 04: more platforms. All are Postiz providers (v2.25.0).
  'threads',
  'bluesky',
  'mastodon',
  'linkedin',
  'reddit',
  'pinterest',
  'telegram',
  'discord',
  'medium',
  'farcaster',
  'nostr',
  'lemmy',
  // Amendment 04, second batch: every other Postiz provider (v2.25.0).
  'slack',
  'wordpress',
  'listmonk',
  'vk',
  'gmb',
  'tumblr',
  'dribbble',
  'mewe',
  'skool',
  'whop',
  'moltbook',
  'kick',
  'twitch',
  'tiktok',
  'youtube',
] as const
export type Platform = (typeof PLATFORMS)[number]

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value)
}

export const PLATFORM_LABELS: Record<Platform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  'linkedin-page': 'LinkedIn (pagina)',
  x: 'X',
  devto: 'dev.to',
  hashnode: 'Hashnode',
  substack: 'Substack',
  producthunt: 'Product Hunt',
  threads: 'Threads',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  linkedin: 'LinkedIn (profil)',
  reddit: 'Reddit',
  pinterest: 'Pinterest',
  telegram: 'Telegram',
  discord: 'Discord',
  medium: 'Medium',
  farcaster: 'Farcaster',
  nostr: 'Nostr',
  lemmy: 'Lemmy',
  slack: 'Slack',
  wordpress: 'WordPress',
  listmonk: 'Listmonk',
  vk: 'VK',
  gmb: 'Google Business',
  tumblr: 'Tumblr',
  dribbble: 'Dribbble',
  mewe: 'MeWe',
  skool: 'Skool',
  whop: 'Whop',
  moltbook: 'Moltbook',
  kick: 'Kick',
  twitch: 'Twitch',
  tiktok: 'TikTok',
  youtube: 'YouTube',
}

/**
 * Always a manual handoff, whatever the account says (PRD section 5).
 * Substack and Product Hunt have no publishing API; YouTube's Postiz provider
 * only publishes video, and this app makes text and images (amendment 04).
 * Every other platform can still be switched to manual mode account by
 * account (a channel waiting for a platform's approval).
 */
export const MANUAL_ONLY_PLATFORMS: readonly Platform[] = ['substack', 'producthunt', 'youtube']

/** Why a platform is manual-only, for the handoff page and the accounts screen. */
export const MANUAL_ONLY_REASONS: Partial<Record<Platform, string>> = {
  substack: 'Substack nu are API de publicare.',
  producthunt: 'Product Hunt nu are API pentru lansari.',
  youtube: 'YouTube cere video, iar aplicatia face doar text si imagini: filmul se incarca manual, textul de mai jos e pentru titlu si descriere.',
}

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
  threads: 'social',
  bluesky: 'social',
  mastodon: 'social',
  linkedin: 'social',
  reddit: 'social',
  pinterest: 'social',
  telegram: 'social',
  discord: 'social',
  medium: 'article',
  farcaster: 'social',
  nostr: 'social',
  lemmy: 'social',
  slack: 'social',
  wordpress: 'article',
  listmonk: 'article',
  vk: 'social',
  gmb: 'social',
  tumblr: 'social',
  dribbble: 'social',
  mewe: 'social',
  skool: 'social',
  whop: 'social',
  moltbook: 'social',
  kick: 'social',
  twitch: 'social',
  tiktok: 'social',
  youtube: 'social',
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
  // Amendment 04: Pinterest pins are 2:3.
  pinterest: { width: 1000, height: 1500 },
  // Dribbble shots must be 400x300 or 800x600 (4:3); Google Business uses the same shape.
  dribbble: { width: 800, height: 600 },
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
  threads: 'square',
  bluesky: 'x',
  mastodon: 'x',
  linkedin: 'square',
  reddit: 'x',
  pinterest: 'pinterest',
  telegram: 'x',
  discord: 'x',
  medium: 'hashnode_cover',
  farcaster: 'x',
  nostr: 'x',
  lemmy: 'square',
  slack: 'x',
  wordpress: 'hashnode_cover',
  listmonk: 'hashnode_cover',
  vk: 'x',
  gmb: 'dribbble',
  tumblr: 'x',
  dribbble: 'dribbble',
  mewe: 'square',
  skool: 'x',
  whop: 'x',
  moltbook: 'x',
  kick: 'x',
  twitch: 'x',
  tiktok: 'portrait',
  youtube: 'x',
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

/**
 * Postiz provider identifiers (with the spellings seen in v2.25.0) to our
 * platforms. The identifier is the `identifier` field of Postiz's
 * GET /public/v1/integrations (the worker also accepts `providerIdentifier`).
 * Farcaster is `wrapcast` in Postiz; `mastodon-custom` is a Mastodon channel
 * on an instance the operator chose.
 */
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
  threads: 'threads',
  bluesky: 'bluesky',
  mastodon: 'mastodon',
  'mastodon-custom': 'mastodon',
  linkedin: 'linkedin',
  reddit: 'reddit',
  pinterest: 'pinterest',
  telegram: 'telegram',
  discord: 'discord',
  medium: 'medium',
  wrapcast: 'farcaster',
  farcaster: 'farcaster',
  nostr: 'nostr',
  lemmy: 'lemmy',
  slack: 'slack',
  wordpress: 'wordpress',
  listmonk: 'listmonk',
  vk: 'vk',
  gmb: 'gmb',
  tumblr: 'tumblr',
  dribbble: 'dribbble',
  mewe: 'mewe',
  skool: 'skool',
  whop: 'whop',
  moltbook: 'moltbook',
  kick: 'kick',
  twitch: 'twitch',
  tiktok: 'tiktok',
  'tiktok-business': 'tiktok',
  youtube: 'youtube',
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
  threads: 'https://www.threads.com/',
  bluesky: 'https://bsky.app/',
  mastodon: 'https://joinmastodon.org/servers',
  linkedin: 'https://www.linkedin.com/feed/',
  reddit: 'https://www.reddit.com/submit',
  pinterest: 'https://www.pinterest.com/pin-creation-tool/',
  telegram: 'https://web.telegram.org/',
  discord: 'https://discord.com/channels/@me',
  medium: 'https://medium.com/new-story',
  farcaster: 'https://warpcast.com/',
  nostr: 'https://nostrudel.ninja/',
  lemmy: 'https://join-lemmy.org/instances',
  slack: 'https://app.slack.com/',
  wordpress: 'https://wordpress.com/post',
  listmonk: 'https://listmonk.app/',
  vk: 'https://vk.com/feed',
  gmb: 'https://business.google.com/',
  tumblr: 'https://www.tumblr.com/new/text',
  dribbble: 'https://dribbble.com/uploads/new',
  mewe: 'https://mewe.com/',
  skool: 'https://www.skool.com/',
  whop: 'https://whop.com/',
  moltbook: 'https://www.moltbook.com/',
  kick: 'https://kick.com/',
  twitch: 'https://www.twitch.tv/',
  tiktok: 'https://www.tiktok.com/creator-center/upload',
  youtube: 'https://studio.youtube.com/',
}
