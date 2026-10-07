/**
 * Validation of one destination against PRD section 8.2 (hard checks, which
 * block approval) and the platform rules of section 5. Errors block approval;
 * warnings are shown and do not. Pure: the composer runs it on every
 * keystroke, the server runs it again before approving.
 */

import {
  CARD_TEMPLATES,
  MEDIA_MIME_TYPES,
  PLATFORM_LABELS,
  type Platform,
  type PostKind,
} from './constants.ts'
import {
  countHashtags,
  findBannedPhrases,
  findBareDomains,
  findDiacritics,
  findLegalNames,
  findMiswrittenBrandNames,
  findUrls,
  isOurBlogUrl,
} from './content-rules.ts'
import { detectFigures, unlistedFigures, unverifiedFigures, type DraftFigure, type FigureMatch } from './figures.ts'
import { lengthUnit, measurePlatformLength, utf8Length } from './text-length.ts'
import { REDDIT_POST_TYPES } from './platform-settings.ts'
import { X_MAX_WEIGHTED_LENGTH } from './x-length.ts'

export interface ValidationIssue {
  code: string
  message: string
  field?: string
}

export interface ValidationMedia {
  mediaId?: string
  mime?: string | null
  width?: number | null
  height?: number | null
  altText: string
}

export interface ValidateDestinationInput {
  platform: Platform
  kind?: PostKind
  text: string
  settings: Record<string, unknown>
  media: ReadonlyArray<ValidationMedia>
  /** The draft's figure list for this destination. */
  figures?: ReadonlyArray<DraftFigure>
  /** ISO instant, or null when not chosen yet. */
  scheduledAt?: string | null
  /** For the "in the past" check; defaults to now. */
  now?: Date
  /** From Postiz account sync (`max_length` / `maxLength`), when known. */
  rules?: Record<string, unknown> | null
  /** Operator company name(s): never in a post. */
  legalNames?: ReadonlyArray<string>
}

export interface DestinationValidation {
  ok: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  containsFigures: boolean
  figures: FigureMatch[]
  /** Counted the platform's way (X weighted). */
  length: number
  maxLength: number | null
}

/** Character limits (PRD section 5); Facebook's own limit where the PRD has none. */
export const PLATFORM_MAX_LENGTH: Partial<Record<Platform, number>> = {
  x: X_MAX_WEIGHTED_LENGTH,
  instagram: 2200,
  'linkedin-page': 3000,
  facebook: 63206,
  producthunt: 260,
  // Amendment 04 (sources in PRD section 5). Postiz's provider limit is used
  // where it is lower than the platform's own.
  threads: 500,
  bluesky: 300, // graphemes
  mastodon: 500, // a link counts 23
  linkedin: 3000,
  reddit: 10000, // body; Reddit itself allows 40,000
  pinterest: 500, // description; the Pinterest API allows 800
  telegram: 4096, // 1,024 when an image is attached (caption): TELEGRAM_CAPTION_MAX
  discord: 1980, // Discord's message limit is 2,000; Postiz keeps 1,980
  medium: 100000,
  farcaster: 320, // UTF-8 bytes; a long cast (Farcaster Pro) holds 1,024
  nostr: 100000,
  lemmy: 10000, // body; Lemmy itself allows 50,000
}

export const MAX_IMAGES: Partial<Record<Platform, number>> = {
  x: 4,
  instagram: 10,
  facebook: 10,
  'linkedin-page': 9,
  devto: 1,
  hashnode: 1,
  threads: 20, // carousel
  bluesky: 4,
  mastodon: 4, // instance default
  linkedin: 9,
  reddit: 1, // a media post holds exactly one file
  pinterest: 5,
  telegram: 10, // one media group
  discord: 10, // attachments per message
  medium: 1,
  farcaster: 2, // embeds per cast
  lemmy: 1, // the post's thumbnail
}

export const COVER_SIZES: Partial<Record<Platform, { width: number; height: number }>> = {
  devto: { width: 1000, height: 420 },
  hashnode: { width: 1600, height: 840 },
  producthunt: { width: 1270, height: 760 },
  pinterest: { width: 1000, height: 1500 },
}

/** Alt text limits that are documented: Mastodon 1,500, Lemmy 1,500, Pinterest 500. */
export const ALT_TEXT_MAX: Partial<Record<Platform, number>> = { mastodon: 1500, lemmy: 1500, pinterest: 500 }

export const TELEGRAM_CAPTION_MAX = 1024
export const BLUESKY_MAX_BYTES = 3000
export const REDDIT_TITLE_MAX = 300
export const PINTEREST_TITLE_MAX = 100
export const PINTEREST_LINK_MAX = 2048
export const LEMMY_TITLE_MIN = 3
export const LEMMY_TITLE_MAX = 200
export const LEMMY_LINK_MAX = 2000
export const MEDIUM_MAX_TAGS = 3
export const MEDIUM_TAG_MAX = 25
export const THREADS_TOPIC_TAGS = 1

const SUBREDDIT_RE = /^(?:\/?r\/)?[A-Za-z0-9_]{2,21}$/
const DISCORD_CHANNEL_RE = /^\d{17,20}$/
const NUMERIC_ID_RE = /^\d+$/
const LEMMY_COMMUNITY_RE = /^[A-Za-z0-9_]{2,40}$/
const FARCASTER_CHANNEL_RE = /^[a-z0-9-]{1,40}$/

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

export const PH_TAGLINE_MAX = 60
export const PH_DESCRIPTION_MAX = 260
export const DEVTO_MAX_TAGS = 4
export const HASHNODE_MAX_TAGS = 5
export const INSTAGRAM_MAX_HASHTAGS = 30
export const INSTAGRAM_MIN_ASPECT = 4 / 5
export const INSTAGRAM_MAX_ASPECT = 1.91

/** Settings fields whose text is published, per platform. */
const TEXT_SETTINGS = ['title', 'subtitle', 'name', 'tagline', 'maker_comment'] as const

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function tagsOf(settings: Record<string, unknown>): string[] {
  const t = settings.tags
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : []
}

function rulesMaxLength(rules: Record<string, unknown> | null | undefined): number | null {
  if (!rules) return null
  for (const k of ['max_length', 'maxLength']) {
    const v = rules[k]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
  }
  return null
}

/**
 * The limit for a destination. `imageCount` matters for Telegram only: with
 * an image the text becomes its caption, which holds 1,024 characters.
 */
export function maxLengthFor(
  platform: Platform,
  rules?: Record<string, unknown> | null,
  imageCount = 0
): number | null {
  let base = PLATFORM_MAX_LENGTH[platform] ?? null
  if (platform === 'telegram' && imageCount > 0 && base !== null) base = Math.min(base, TELEGRAM_CAPTION_MAX)
  const fromPostiz = rulesMaxLength(rules)
  if (base === null) return fromPostiz
  return fromPostiz === null ? base : Math.min(base, fromPostiz)
}

/** The length the platform counts (X weighted, Bluesky graphemes, Farcaster bytes, ...): see text-length.ts. */
export function measureLength(platform: Platform, text: string): number {
  return measurePlatformLength(platform, text)
}

/** Every published string of the destination, labelled for messages. */
function publishedStrings(input: ValidateDestinationInput): Array<{ field: string; value: string }> {
  const out = [{ field: 'text', value: input.text }]
  for (const k of TEXT_SETTINGS) {
    const v = str(input.settings[k])
    if (v) out.push({ field: `settings.${k}`, value: v })
  }
  tagsOf(input.settings).forEach((t, i) => out.push({ field: `settings.tags.${i}`, value: t }))
  input.media.forEach((m, i) => out.push({ field: `media.${i}.alt_text`, value: m.altText }))
  return out
}

const FIELD_LABELS: Record<string, string> = {
  text: 'text',
  'settings.title': 'titlu',
  'settings.subtitle': 'subtitlu',
  'settings.name': 'nume',
  'settings.tagline': 'tagline',
  'settings.maker_comment': 'comentariul makerului',
}

function fieldLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field]
  if (field.startsWith('settings.tags.')) return 'etichete'
  if (field.startsWith('media.')) return `textul alternativ al imaginii ${Number(field.split('.')[1]) + 1}`
  return field
}

/**
 * Required fields and limits of the platforms added in amendment 04 (the
 * sources are in the PRD section 5 table). Text length, image count and alt
 * text are checked by validateDestination for every platform.
 */
function validateNewPlatform(input: ValidateDestinationInput, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  const { platform, settings } = input
  const err = (code: string, field: string, message: string) => errors.push({ code, field, message })
  const warn = (code: string, field: string, message: string) => warnings.push({ code, field, message })
  const chars = (v: string) => Array.from(v).length

  switch (platform) {
    case 'threads': {
      const tags = countHashtags(input.text)
      if (tags > THREADS_TOPIC_TAGS) {
        warn('THREADS_HASHTAGS', 'text', `Threads face tag de subiect doar din primul hashtag; ai ${tags} hashtaguri.`)
      }
      break
    }
    case 'reddit': {
      const sub = str(settings.subreddit).trim()
      if (!sub) {
        err('REDDIT_SUBREDDIT_MISSING', 'settings.subreddit', 'Reddit: alege subreddit-ul (de exemplu r/numele_comunitatii).')
      } else if (!SUBREDDIT_RE.test(sub)) {
        err('REDDIT_SUBREDDIT_INVALID', 'settings.subreddit', 'Reddit: subreddit-ul arata ca r/nume (litere, cifre si _, 2 pana la 21).')
      }
      const title = str(settings.title).trim()
      if (!title) {
        err('REDDIT_TITLE_MISSING', 'settings.title', 'Reddit: lipseste titlul.')
      } else if (chars(title) > REDDIT_TITLE_MAX) {
        err('REDDIT_TITLE_TOO_LONG', 'settings.title', `Reddit: titlul are ${chars(title)} din ${REDDIT_TITLE_MAX} caractere.`)
      }
      const type = str(settings.post_type).trim() || 'self'
      if (!(REDDIT_POST_TYPES as readonly string[]).includes(type)) {
        err('REDDIT_TYPE_INVALID', 'settings.post_type', 'Reddit: tipul postarii e Text, Link sau Imagine.')
      }
      if (type === 'link') {
        const url = str(settings.link_url).trim()
        if (!url) err('REDDIT_LINK_MISSING', 'settings.link_url', 'Reddit: o postare de tip Link are nevoie de link.')
        else if (!isHttpUrl(url)) err('REDDIT_LINK_INVALID', 'settings.link_url', 'Reddit: linkul trebuie sa inceapa cu https://.')
      }
      if (type === 'media' && input.media.length !== 1) {
        err('REDDIT_MEDIA_COUNT', 'media', 'Reddit: o postare cu imagine are exact o imagine.')
      }
      if (type !== 'media' && input.media.length > 0) {
        warn('REDDIT_IMAGE_IGNORED', 'media', 'Reddit publica imaginea doar la tipul Imagine; la celelalte tipuri nu apare.')
      }
      break
    }
    case 'pinterest': {
      if (input.media.length === 0) {
        err('PIN_NO_IMAGE', 'media', 'Pinterest are nevoie de cel putin o imagine.')
      }
      const board = str(settings.board).trim()
      if (!board) {
        err('PIN_BOARD_MISSING', 'settings.board', 'Pinterest: alege board-ul (id-ul numeric din Postiz).')
      } else if (!NUMERIC_ID_RE.test(board)) {
        err('PIN_BOARD_INVALID', 'settings.board', 'Pinterest: board-ul se da prin id-ul numeric, nu prin nume.')
      }
      const title = str(settings.title).trim()
      if (!title) {
        err('PIN_TITLE_MISSING', 'settings.title', 'Pinterest: lipseste titlul.')
      } else if (chars(title) > PINTEREST_TITLE_MAX) {
        err('PIN_TITLE_TOO_LONG', 'settings.title', `Pinterest: titlul are ${chars(title)} din ${PINTEREST_TITLE_MAX} caractere.`)
      }
      const link = str(settings.link).trim()
      if (!link) {
        err('PIN_LINK_MISSING', 'settings.link', 'Pinterest: lipseste linkul unde duce pinul.')
      } else if (!isHttpUrl(link) || link.length > PINTEREST_LINK_MAX) {
        err('PIN_LINK_INVALID', 'settings.link', `Pinterest: linkul trebuie sa inceapa cu https:// si sa aiba cel mult ${PINTEREST_LINK_MAX} de caractere.`)
      }
      break
    }
    case 'discord': {
      const channel = str(settings.channel).trim()
      if (!channel) {
        err('DISCORD_CHANNEL_MISSING', 'settings.channel', 'Discord: alege canalul (id numeric).')
      } else if (!DISCORD_CHANNEL_RE.test(channel)) {
        err('DISCORD_CHANNEL_INVALID', 'settings.channel', 'Discord: canalul se da prin id-ul numeric (17 pana la 20 de cifre).')
      }
      break
    }
    case 'lemmy': {
      const community = str(settings.community).trim()
      if (!community) {
        err('LEMMY_COMMUNITY_MISSING', 'settings.community', 'Lemmy: alege comunitatea.')
      } else if (!LEMMY_COMMUNITY_RE.test(community)) {
        err('LEMMY_COMMUNITY_INVALID', 'settings.community', 'Lemmy: comunitatea se scrie doar cu numele (litere, cifre si _), fara instanta.')
      }
      const id = str(settings.community_id).trim()
      if (!id) {
        err('LEMMY_COMMUNITY_ID_MISSING', 'settings.community_id', 'Lemmy: lipseste id-ul numeric al comunitatii.')
      } else if (!NUMERIC_ID_RE.test(id)) {
        err('LEMMY_COMMUNITY_ID_INVALID', 'settings.community_id', 'Lemmy: id-ul comunitatii e un numar.')
      }
      const title = str(settings.title).trim()
      if (!title) {
        err('LEMMY_TITLE_MISSING', 'settings.title', 'Lemmy: lipseste titlul.')
      } else if (chars(title) < LEMMY_TITLE_MIN || chars(title) > LEMMY_TITLE_MAX || /[\r\n]/.test(title)) {
        err('LEMMY_TITLE_LENGTH', 'settings.title', `Lemmy: titlul are intre ${LEMMY_TITLE_MIN} si ${LEMMY_TITLE_MAX} de caractere, pe un singur rand.`)
      }
      const link = str(settings.link).trim()
      if (link && (!isHttpUrl(link) || link.length > LEMMY_LINK_MAX)) {
        err('LEMMY_LINK_INVALID', 'settings.link', `Lemmy: linkul trebuie sa inceapa cu https:// si sa aiba cel mult ${LEMMY_LINK_MAX} de caractere.`)
      }
      break
    }
    case 'medium': {
      if (!str(settings.subtitle).trim()) {
        err('MEDIUM_SUBTITLE_MISSING', 'settings.subtitle', 'Medium: lipseste subtitlul (Postiz il cere).')
      }
      tagsOf(settings).forEach((t, i) => {
        if (chars(t) > MEDIUM_TAG_MAX) {
          err('TAG_TOO_LONG', `settings.tags.${i}`, `Medium ignora etichetele de peste ${MEDIUM_TAG_MAX} de caractere ("${t}").`)
        }
      })
      if (input.media.length > 0) {
        warn('MEDIUM_NO_COVER', 'media', 'Medium nu primeste imagini prin Postiz; pune imaginile in text ca markdown.')
      }
      break
    }
    case 'farcaster': {
      const channel = str(settings.channel).trim()
      if (channel && !FARCASTER_CHANNEL_RE.test(channel)) {
        err('FARCASTER_CHANNEL_INVALID', 'settings.channel', 'Farcaster: canalul se scrie cu litere mici, cifre si cratima (de exemplu founders).')
      }
      break
    }
    default:
      break
  }
}

export function validateDestination(input: ValidateDestinationInput): DestinationValidation {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const { platform, settings } = input
  const label = PLATFORM_LABELS[platform]
  const text = input.text ?? ''
  const strings = publishedStrings(input)

  if (!text.trim()) {
    errors.push({ code: 'EMPTY_TEXT', field: 'text', message: `Textul pentru ${label} e gol.` })
  }

  // Diacritics, banned phrases, legal name, bare domain: every published string.
  for (const { field, value } of strings) {
    const where = fieldLabel(field)
    const diacritics = findDiacritics(value)
    if (diacritics.length) {
      errors.push({
        code: 'DIACRITICS',
        field,
        message: `Fara diacritice: am gasit ${diacritics.join(' ')} in ${where}.`,
      })
    }
    for (const phrase of findBannedPhrases(value)) {
      errors.push({ code: 'BANNED_PHRASE', field, message: `Expresie interzisa in ${where}: "${phrase}".` })
    }
    if (findLegalNames(value, input.legalNames ?? []).length) {
      errors.push({ code: 'LEGAL_NAME', field, message: `Numele firmei operatorului nu apare in postari (${where}).` })
    }
    for (const domain of findBareDomains(value)) {
      errors.push({
        code: 'BARE_DOMAIN',
        field,
        message: `"${domain}" apare ca text in ${where}. Domeniul apare doar intr-un link (https://...).`,
      })
    }
    for (const wrong of findMiswrittenBrandNames(value)) {
      warnings.push({
        code: 'BRAND_NAME',
        field,
        message: `Numele brandului se scrie exact "Taxes Support" / "The Crypto Support", nu "${wrong}".`,
      })
    }
  }

  // Length, counted the platform's way.
  const maxLength = maxLengthFor(platform, input.rules, input.media.length)
  const length = measureLength(platform, text)
  if (maxLength !== null && length > maxLength) {
    errors.push({
      code: 'TOO_LONG',
      field: 'text',
      message:
        platform === 'x'
          ? `Prea lung pentru X: ${length} din ${maxLength} (cu ponderea X, un link = 23).`
          : platform === 'mastodon'
            ? `Prea lung pentru Mastodon: ${length} din ${maxLength} caractere (un link = 23).`
            : platform === 'telegram' && input.media.length > 0 && maxLength === TELEGRAM_CAPTION_MAX
              ? `Prea lung pentru Telegram cu imagine: ${length} din ${maxLength} caractere (textul devine descrierea imaginii).`
              : `Prea lung pentru ${label}: ${length} din ${maxLength} ${lengthUnit(platform)}.`,
    })
  }
  if (platform === 'bluesky' && utf8Length(text) > BLUESKY_MAX_BYTES) {
    errors.push({
      code: 'TOO_LONG_BYTES',
      field: 'text',
      message: `Prea lung pentru Bluesky: ${utf8Length(text)} din ${BLUESKY_MAX_BYTES} octeti (emoji-urile ocupa mai multi).`,
    })
  }

  // Media: alt text always (F3), counts and shapes per platform.
  input.media.forEach((m, i) => {
    if (!m.altText.trim()) {
      errors.push({
        code: 'ALT_TEXT_MISSING',
        field: `media.${i}.alt_text`,
        message: `Imaginea ${i + 1} nu are text alternativ.`,
      })
    }
    if (m.mime && !(MEDIA_MIME_TYPES as readonly string[]).includes(m.mime)) {
      errors.push({ code: 'MEDIA_TYPE', field: `media.${i}`, message: `Imaginea ${i + 1} nu e JPEG, PNG sau WebP.` })
    }
  })
  const maxImages = MAX_IMAGES[platform]
  if (maxImages !== undefined && input.media.length > maxImages) {
    errors.push({
      code: 'TOO_MANY_IMAGES',
      field: 'media',
      message: `${label} primeste cel mult ${maxImages} ${maxImages === 1 ? 'imagine' : 'imagini'}.`,
    })
  }

  if (platform === 'instagram') {
    if (input.media.length === 0) {
      errors.push({ code: 'IG_NO_IMAGE', field: 'media', message: 'Instagram are nevoie de cel putin o imagine.' })
    }
    if (findUrls(text).length) {
      errors.push({
        code: 'IG_URL',
        field: 'text',
        message: 'Fara linkuri in descrierea de pe Instagram (nu se pot apasa). Trimite la "link in bio".',
      })
    }
    const tags = countHashtags(text)
    if (tags > INSTAGRAM_MAX_HASHTAGS) {
      errors.push({
        code: 'IG_HASHTAGS',
        field: 'text',
        message: `Instagram accepta cel mult ${INSTAGRAM_MAX_HASHTAGS} hashtaguri (ai ${tags}).`,
      })
    }
    input.media.forEach((m, i) => {
      if (m.width && m.height) {
        const ratio = m.width / m.height
        if (ratio < INSTAGRAM_MIN_ASPECT - 0.005 || ratio > INSTAGRAM_MAX_ASPECT + 0.005) {
          errors.push({
            code: 'IG_ASPECT',
            field: `media.${i}`,
            message: `Imaginea ${i + 1} are proportia ${m.width}x${m.height}; Instagram cere intre 4:5 si 1.91:1.`,
          })
        }
      }
    })
  }

  const altMax = ALT_TEXT_MAX[platform]
  if (altMax !== undefined) {
    input.media.forEach((m, i) => {
      if (Array.from(m.altText).length > altMax) {
        errors.push({
          code: 'ALT_TEXT_TOO_LONG',
          field: `media.${i}.alt_text`,
          message: `Textul alternativ al imaginii ${i + 1} are peste ${altMax} de caractere (limita ${label}).`,
        })
      }
    })
  }

  if (platform === 'devto' || platform === 'hashnode' || platform === 'substack' || platform === 'medium') {
    if (!str(settings.title).trim()) {
      errors.push({ code: 'TITLE_MISSING', field: 'settings.title', message: `Articolul pentru ${label} nu are titlu.` })
    }
  }

  validateNewPlatform(input, errors, warnings)

  if (platform === 'devto' || platform === 'hashnode' || platform === 'medium') {
    const tags = tagsOf(settings)
    const maxTags = platform === 'devto' ? DEVTO_MAX_TAGS : platform === 'hashnode' ? HASHNODE_MAX_TAGS : MEDIUM_MAX_TAGS
    if (tags.length > maxTags) {
      errors.push({
        code: 'TOO_MANY_TAGS',
        field: 'settings.tags',
        message: `${label} accepta cel mult ${maxTags} etichete (ai ${tags.length}).`,
      })
    }
    const canonical = settings.canonical_url
    if (!str(canonical).trim()) {
      errors.push({
        code: 'CANONICAL_MISSING',
        field: 'settings.canonical_url',
        message: `${label}: seteaza linkul canonic catre articolul de pe blogul nostru.`,
      })
    } else if (!isOurBlogUrl(canonical)) {
      errors.push({
        code: 'CANONICAL_NOT_OURS',
        field: 'settings.canonical_url',
        message: `${label}: linkul canonic trebuie sa fie https pe thecrypto.support sau taxes.support.`,
      })
    }
    const cover = settings.cover_media_id
    if (cover !== undefined && cover !== null && cover !== '') {
      const ids = input.media.map((m) => m.mediaId).filter(Boolean)
      if (ids.length && !ids.includes(String(cover))) {
        errors.push({
          code: 'COVER_NOT_ATTACHED',
          field: 'settings.cover_media_id',
          message: `${label}: coperta nu e printre imaginile atasate.`,
        })
      }
    }
  }

  const cover = COVER_SIZES[platform]
  if (cover && input.media[0]?.width && input.media[0]?.height) {
    const m = input.media[0]
    if (m.width !== cover.width || m.height !== cover.height) {
      warnings.push({
        code: 'COVER_SIZE',
        field: 'media.0',
        message: `${label} recomanda ${cover.width}x${cover.height}; imaginea are ${m.width}x${m.height}.`,
      })
    }
  }

  if (platform === 'producthunt') {
    if (!str(settings.name).trim()) {
      errors.push({ code: 'PH_NAME_MISSING', field: 'settings.name', message: 'Product Hunt: lipseste numele.' })
    }
    const tagline = str(settings.tagline)
    if (!tagline.trim()) {
      errors.push({ code: 'PH_TAGLINE_MISSING', field: 'settings.tagline', message: 'Product Hunt: lipseste tagline-ul.' })
    } else if (Array.from(tagline).length > PH_TAGLINE_MAX) {
      errors.push({
        code: 'PH_TAGLINE_TOO_LONG',
        field: 'settings.tagline',
        message: `Product Hunt: tagline-ul are ${Array.from(tagline).length} din ${PH_TAGLINE_MAX} caractere.`,
      })
    }
    if (!str(settings.maker_comment).trim()) {
      warnings.push({
        code: 'PH_MAKER_COMMENT_MISSING',
        field: 'settings.maker_comment',
        message: 'Product Hunt: lipseste comentariul makerului.',
      })
    }
  }

  // Figures (PRD 8.2).
  const figures = strings.flatMap(({ value }) => detectFigures(value))
  const containsFigures = figures.length > 0
  const listed = input.figures ?? []
  for (const f of unverifiedFigures(listed)) {
    errors.push({
      code: 'UNVERIFIED_FIGURE',
      field: 'figures',
      message: `Cifra "${f.value}" nu are sursa (unverified). Corecteaz-o sau confirma sursa inainte de aprobare.`,
    })
  }
  if (containsFigures) {
    const extra = unlistedFigures(strings.map((s) => s.value).join('\n'), listed)
    if (extra.length) {
      warnings.push({
        code: 'FIGURE_NOT_LISTED',
        field: 'text',
        message: `Cifre care nu sunt in lista ciornei: ${[...new Set(extra.map((e) => e.value))].slice(0, 6).join(', ')}. Verifica-le.`,
      })
    }
  }

  // Time.
  if (input.scheduledAt === null || input.scheduledAt === undefined || input.scheduledAt === '') {
    errors.push({ code: 'MISSING_TIME', field: 'scheduled_at', message: `Alege data si ora pentru ${label}.` })
  } else {
    const at = new Date(input.scheduledAt).getTime()
    const now = (input.now ?? new Date()).getTime()
    if (!Number.isFinite(at)) {
      errors.push({ code: 'MISSING_TIME', field: 'scheduled_at', message: `Data pentru ${label} nu e valida.` })
    } else if (at < now - 60_000) {
      errors.push({ code: 'TIME_IN_PAST', field: 'scheduled_at', message: `Ora pentru ${label} a trecut deja.` })
    }
  }

  return { ok: errors.length === 0, errors, warnings, containsFigures, figures, length, maxLength }
}

// ---------------------------------------------------------------------------
// Card spec (PRD 10.5)
// ---------------------------------------------------------------------------

export interface CardSpec {
  template: string
  headline: string
  keyword?: string | null
  stat?: string | null
  subline?: string | null
  brand: string
  alt_text?: string | null
}

export const CARD_LIMITS = { headline: 70, stat: 8, subline: 110 } as const

export function validateCardSpec(card: CardSpec, legalNames: ReadonlyArray<string> = []): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!(CARD_TEMPLATES as readonly string[]).includes(card.template)) {
    issues.push({ code: 'CARD_TEMPLATE', field: 'card.template', message: 'Sablonul cardului e light, dark sau mint.' })
  }
  const headline = card.headline ?? ''
  if (!headline.trim()) {
    issues.push({ code: 'CARD_HEADLINE_MISSING', field: 'card.headline', message: 'Cardul nu are titlu.' })
  } else if (Array.from(headline).length > CARD_LIMITS.headline) {
    issues.push({
      code: 'CARD_HEADLINE_TOO_LONG',
      field: 'card.headline',
      message: `Titlul cardului are ${Array.from(headline).length} din ${CARD_LIMITS.headline} caractere.`,
    })
  }
  if (card.keyword && !headline.includes(card.keyword)) {
    issues.push({
      code: 'CARD_KEYWORD',
      field: 'card.keyword',
      message: 'Cuvantul evidentiat trebuie sa apara exact in titlul cardului.',
    })
  }
  if (card.stat && Array.from(card.stat).length > CARD_LIMITS.stat) {
    issues.push({
      code: 'CARD_STAT_TOO_LONG',
      field: 'card.stat',
      message: `Cifra cardului are cel mult ${CARD_LIMITS.stat} caractere.`,
    })
  }
  if (card.subline && Array.from(card.subline).length > CARD_LIMITS.subline) {
    issues.push({
      code: 'CARD_SUBLINE_TOO_LONG',
      field: 'card.subline',
      message: `Randul de sub titlu are cel mult ${CARD_LIMITS.subline} caractere.`,
    })
  }
  for (const [field, value] of [
    ['card.headline', headline],
    ['card.stat', card.stat ?? ''],
    ['card.subline', card.subline ?? ''],
    ['card.alt_text', card.alt_text ?? ''],
  ] as const) {
    if (findDiacritics(value).length) {
      issues.push({ code: 'DIACRITICS', field, message: 'Fara diacritice pe card.' })
    }
    for (const phrase of findBannedPhrases(value)) {
      issues.push({ code: 'BANNED_PHRASE', field, message: `Expresie interzisa pe card: "${phrase}".` })
    }
    if (findLegalNames(value, legalNames).length) {
      issues.push({ code: 'LEGAL_NAME', field, message: 'Numele firmei operatorului nu apare pe card.' })
    }
    if (findBareDomains(value).length) {
      issues.push({ code: 'BARE_DOMAIN', field, message: 'Domeniul nu apare ca text pe card.' })
    }
  }
  return issues
}
