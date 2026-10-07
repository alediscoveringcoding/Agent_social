/**
 * Manual handoff (PRD flow 6.2, F8): what a person copies into a platform's
 * own editor. Pure and browser-safe, so the page and the tests share it.
 *
 *  - copy formats: plain text, markdown and HTML of the body, plus the
 *    separate fields an editor asks for (title, subtitle, tagline, ...);
 *  - a checklist per platform (Product Hunt's is the long one);
 *  - file names for the text downloads.
 *
 * The HTML is built from escaped text: nothing the generator or an editor
 * wrote can become markup except the small markdown subset below, and links
 * only ever point to http(s) or mailto.
 */

import { MANUAL_ONLY_REASONS, PLATFORM_KIND, PLATFORM_LABELS, type Platform, type PostKind } from './constants.ts'
import { SETTINGS_FIELDS } from './platform-settings.ts'

// ---------------------------------------------------------------------------
// Markdown subset to HTML / plain text
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const SAFE_HREF = /^(https?:\/\/|mailto:)/i
// A bare URL in raw text; stops at whitespace, quotes, angle brackets, and
// does not swallow a closing bracket or trailing punctuation.
const BARE_URL = /\bhttps?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]/gi
const SLOT = /\u0000(\d+)\u0000/g

function anchor(url: string, text = url): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`
}

/** Raw text to HTML with bare http(s) URLs as links; everything else escaped. */
export function linkify(raw: string): string {
  let out = ''
  let last = 0
  for (const m of raw.matchAll(BARE_URL)) {
    out += escapeHtml(raw.slice(last, m.index)) + anchor(m[0])
    last = m.index + m[0].length
  }
  return out + escapeHtml(raw.slice(last))
}

/** Inline markdown on raw text: code, links, bare URLs, bold, italic. */
export function inlineMarkdown(raw: string): string {
  const slots: string[] = []
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`
  let s = raw.split('\u0000').join('')
  // `code`
  s = s.replace(/`([^`\n]+)`/g, (_, code: string) => hold(`<code>${escapeHtml(code)}</code>`))
  // [text](url): only http(s) and mailto become links.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => (SAFE_HREF.test(url) ? hold(anchor(url, text)) : m))
  s = s.replace(BARE_URL, (url) => hold(anchor(url)))
  s = escapeHtml(s)
  s = s.replace(/\*\*(\S(?:[^*\n]*\S)?)\*\*/g, '<strong>$1</strong>').replace(/__(\S(?:[^_\n]*\S)?)__/g, '<strong>$1</strong>')
  s = s
    .replace(/(^|[^*\w])\*(\S(?:[^*\n]*\S)?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_(\S(?:[^_\n]*\S)?)_(?!\w)/g, '$1<em>$2</em>')
  return s.replace(SLOT, (_, i: string) => slots[Number(i)])
}

/**
 * Block markdown: headings, paragraphs, lists, quotes, fenced code, rules.
 * Enough for an article body; anything else stays as escaped text.
 */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let para: string[] = []
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null
  let quote: string[] = []

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inlineMarkdown).join('<br>\n')}</p>`)
    para = []
  }
  const flushList = () => {
    if (list) out.push(`<${list.tag}>\n${list.items.map((i) => `<li>${inlineMarkdown(i)}</li>`).join('\n')}\n</${list.tag}>`)
    list = null
  }
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${markdownToHtml(quote.join('\n'))}</blockquote>`)
    quote = []
  }
  const flushAll = () => {
    flushPara()
    flushList()
    flushQuote()
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fence = /^\s*(```|~~~)/.exec(line)
    if (fence) {
      flushAll()
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) code.push(lines[i++])
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      continue
    }
    if (!line.trim()) {
      flushAll()
      continue
    }
    const quoteLine = /^\s*>\s?(.*)$/.exec(line)
    if (quoteLine) {
      flushPara()
      flushList()
      quote.push(quoteLine[1])
      continue
    }
    flushQuote()
    const heading = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      flushPara()
      flushList()
      const n = heading[1].length
      out.push(`<h${n}>${inlineMarkdown(heading[2])}</h${n}>`)
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara()
      flushList()
      out.push('<hr>')
      continue
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      flushPara()
      const tag = ul ? 'ul' : 'ol'
      if (list && list.tag !== tag) flushList()
      list ??= { tag, items: [] }
      list.items.push((ul ?? ol)![1])
      continue
    }
    if (list) {
      // A continuation line of the last list item.
      list.items[list.items.length - 1] += ` ${line.trim()}`
      continue
    }
    para.push(line.trim())
  }
  flushAll()
  return out.join('\n')
}

/** Markdown to readable plain text: markers dropped, links as "text (url)". */
export function markdownToPlain(md: string): string {
  return md
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*(```|~~~)/.test(l))
    .map((l) =>
      l
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*[-*+]\s+/, '- ')
        .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
        .replace(/\*\*([^*\n]+)\*\*/g, '$1')
        .replace(/__([^_\n]+)__/g, '$1')
        .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1$2')
        .replace(/`([^`\n]+)`/g, '$1')
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A social post's text as HTML: paragraphs, line breaks, links. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${linkify(p).replace(/\n/g, '<br>\n')}</p>`)
    .join('\n')
}

// ---------------------------------------------------------------------------
// What to copy, per platform
// ---------------------------------------------------------------------------

export interface HandoffInput {
  platform: Platform
  kind: PostKind
  title: string | null
  text: string
  settings: Record<string, unknown>
  article?: Record<string, unknown> | null
  launch?: Record<string, unknown> | null
}

export interface HandoffField {
  key: string
  label: string
  value: string
  max?: number
  multiline?: boolean
}

export interface HandoffBody {
  label: string
  plain: string
  markdown: string
  html: string
}

export interface Handoff {
  fields: HandoffField[]
  body: HandoffBody
  checklist: string[]
  /** A reason the person must know before starting (YouTube needs a video). */
  notice?: string
}

const str = (v: unknown): string => (typeof v === 'string' ? v : Array.isArray(v) ? v.map(String).join(', ') : '')

/** Article platforms whose fields come from the settings table (not the dev.to-style title/tags set). */
const FIELD_TABLE_ARTICLES: readonly Platform[] = ['wordpress', 'listmonk', 'linkedin-article', 'github', 'press']

const ARTICLE_BODY_LABELS: Partial<Record<Platform, string>> = {
  listmonk: 'Newsletter',
  press: 'Comunicat',
  github: 'Descriere',
}

function articleLike(platform: Platform, kind: PostKind): boolean {
  return PLATFORM_KIND[platform] === 'article' || (kind === 'article' && platform !== 'producthunt')
}

export function buildHandoff(input: HandoffInput): Handoff {
  const s = input.settings ?? {}
  const a = input.article ?? {}
  const l = input.launch ?? {}
  const fields: HandoffField[] = []
  const add = (key: string, label: string, value: string, extra: Partial<HandoffField> = {}) => {
    if (value.trim()) fields.push({ key, label, value, ...extra })
  }

  if (input.platform === 'producthunt') {
    const description = input.text.trim() || str(l.description)
    add('name', 'Nume', str(s.name) || str(l.name) || input.title || '')
    add('tagline', 'Tagline', str(s.tagline) || str(l.tagline), { max: 60 })
    add('description', 'Descriere', description, { max: 260, multiline: true })
    add('maker_comment', 'Comentariul makerului', str(s.maker_comment) || str(l.maker_comment), { multiline: true })
    return {
      fields,
      body: { label: 'Descriere', plain: description, markdown: description, html: textToHtml(description) },
      checklist: CHECKLISTS.producthunt,
    }
  }

  if (articleLike(input.platform, input.kind)) {
    const body = input.text.trim() ? input.text : str(a.body_markdown)
    if (FIELD_TABLE_ARTICLES.includes(input.platform)) {
      // Fields as the platform's own editor names them (the e-mail subject, the preview line, the list).
      for (const f of SETTINGS_FIELDS[input.platform] ?? []) {
        const fallback = f.key === 'title' ? str(a.title) || input.title || '' : f.key === 'subtitle' ? str(a.subtitle) : ''
        let value = str(s[f.key])
        if (f.kind === 'select') value = f.options?.find((o) => o.value === value)?.label ?? value
        add(f.key, f.label, value || fallback)
      }
    } else {
      add('title', 'Titlu', str(s.title) || str(a.title) || input.title || '')
      add('subtitle', 'Subtitlu', str(s.subtitle) || str(a.subtitle))
      if (input.platform === 'devto' || input.platform === 'hashnode' || input.platform === 'medium') {
        add('tags', 'Taguri', str(s.tags) || str(a.tags))
        add('canonical_url', 'Link canonic', str(s.canonical_url) || str(a.canonical_url))
      }
    }
    return {
      fields,
      body: { label: ARTICLE_BODY_LABELS[input.platform] ?? 'Articol', plain: markdownToPlain(body), markdown: body, html: markdownToHtml(body) },
      checklist: CHECKLISTS[input.platform] ?? CHECKLISTS.article,
    }
  }

  // Amendment 04: Reddit, Pinterest, Lemmy and the others have fields the
  // platform's own editor asks for (subreddit, board, community, title, link).
  for (const f of SETTINGS_FIELDS[input.platform] ?? []) {
    let value = str(s[f.key])
    if (f.kind === 'select') value = f.options?.find((o) => o.value === value)?.label ?? value
    add(f.key, f.label, value, f.max ? { max: f.max } : {})
  }
  return {
    fields,
    body: { label: input.platform === 'youtube' ? 'Descriere' : 'Text', plain: input.text, markdown: input.text, html: textToHtml(input.text) },
    checklist: CHECKLISTS[input.platform] ?? CHECKLISTS.social,
    ...(input.platform === 'youtube' ? { notice: MANUAL_ONLY_REASONS.youtube } : {}),
  }
}

export const CHECKLISTS: Record<string, string[]> = {
  producthunt: [
    'Numele si tagline-ul (cel mult 60 de caractere) sunt completate',
    'Descrierea (cel mult 260 de caractere) e completata',
    'Imaginile din galerie (1270x760) sunt incarcate',
    'Linkul produsului si topicurile sunt setate',
    'Comentariul makerului e pregatit pentru prima ora',
    'Lansarea e programata sau publicata',
  ],
  substack: [
    'Titlul si subtitlul sunt copiate',
    'Corpul articolului e lipit (HTML sau markdown)',
    'Imaginea de coperta e incarcata',
    'Linkurile din text duc unde trebuie',
    'Articolul e publicat, nu doar salvat ca ciorna',
  ],
  article: [
    'Titlul, subtitlul si tagurile sunt completate',
    'Linkul canonic duce la articolul de pe blog',
    'Corpul articolului e lipit si arata bine in previzualizare',
    'Coperta e incarcata',
    'Articolul e publicat',
  ],
  instagram: ['Imaginea e incarcata', 'Descrierea e lipita (fara linkuri)', 'Postarea e publicata pe contul corect'],
  x: ['Textul e lipit (cel mult 280 de caractere)', 'Imaginile sunt atasate', 'Postarea e publicata pe contul corect'],
  social: ['Textul e lipit si recitit', 'Imaginea e atasata', 'Postarea e publicata pe pagina corecta'],
  // Amendment 04.
  threads: ['Textul e lipit (cel mult 500 de caractere)', 'Imaginile sunt atasate', 'Postarea e publicata pe contul corect'],
  bluesky: ['Textul e lipit (cel mult 300 de caractere)', 'Imaginile (cel mult 4) au text alternativ', 'Postarea e publicata pe contul corect'],
  mastodon: ['Textul e lipit (cel mult 500 de caractere, un link = 23)', 'Imaginile (cel mult 4) au text alternativ', 'Postarea e publicata pe contul corect'],
  linkedin: ['Textul e lipit (cel mult 3000 de caractere)', 'Imaginile sunt atasate', 'Postarea e publicata pe profilul corect'],
  reddit: [
    'Subreddit-ul e cel din campurile de mai sus',
    'Titlul (cel mult 300 de caractere) e copiat',
    'Regulile subreddit-ului permit postarea si flair-ul e ales, daca se cere',
    'Textul sau linkul sunt lipite, dupa tipul postarii',
    'Postarea e publicata si linkul ei e salvat',
  ],
  pinterest: [
    'Imaginea (1000x1500) e incarcata',
    'Titlul (cel mult 100 de caractere) si descrierea sunt copiate',
    'Linkul de destinatie e completat',
    'Board-ul corect e ales',
    'Pinul e publicat',
  ],
  telegram: ['Textul e lipit (cel mult 4096 de caractere, 1024 cu imagine)', 'Imaginea e atasata, daca exista', 'Mesajul e trimis in canalul corect'],
  discord: ['Textul e lipit (cel mult 2000 de caractere)', 'Imaginile sunt atasate', 'Mesajul e trimis in canalul corect'],
  medium: [
    'Titlul, subtitlul si etichetele (cel mult 3) sunt completate',
    'Linkul canonic din setarile avansate ale povestirii duce la articolul de pe blog',
    'Corpul articolului e lipit si arata bine in previzualizare',
    'Imaginile sunt incarcate in text',
    'Articolul e publicat',
  ],
  farcaster: ['Textul e lipit (cel mult 320 de octeti)', 'Cel mult 2 imagini sunt atasate', 'Postarea e publicata pe contul si in canalul corect'],
  nostr: ['Textul e lipit', 'Imaginile sunt adaugate ca linkuri', 'Nota e publicata pe contul corect'],
  lemmy: [
    'Comunitatea e cea din campurile de mai sus',
    'Titlul (3 pana la 200 de caractere) e copiat',
    'Textul (si linkul, daca exista) sunt lipite',
    'Postarea e publicata si linkul ei e salvat',
  ],
  // Amendment 04, second batch.
  slack: ['Textul e lipit (cel mult 40000 de caractere)', 'Imaginile sunt atasate', 'Mesajul e trimis in canalul corect'],
  wordpress: [
    'Titlul e copiat si tipul de continut (post sau page) e ales',
    'Corpul articolului e lipit in editorul de blocuri sau in cel clasic',
    'Imaginea reprezentativa e incarcata',
    'Starea (publicat, ciorna, privat) e cea din campurile de mai sus',
    'Articolul e publicat',
  ],
  listmonk: [
    'Subiectul si textul de previzualizare sunt copiate',
    'Lista de abonati si sablonul sunt cele din campurile de mai sus',
    'Corpul e lipit ca HTML in campania noua',
    'Campania a fost trimisa de un test inainte',
    'Campania e programata sau trimisa',
  ],
  vk: ['Textul e lipit (cel mult 2048 de caractere)', 'Imaginile sunt atasate', 'Postarea e publicata pe pagina corecta'],
  gmb: [
    'Textul e lipit (cel mult 1500 de caractere)',
    'O singura imagine e atasata (4:3)',
    'Butonul si linkul lui sunt cele din campurile de mai sus',
    'Postarea e publicata pe locatia corecta',
  ],
  tumblr: ['Titlul, textul si etichetele sunt completate', 'Imaginile (cel mult 30) sunt atasate', 'Postarea e publicata pe blogul corect'],
  dribbble: ['Imaginea (400x300 sau 800x600) e incarcata', 'Titlul si descrierea sunt copiate', 'Shot-ul e publicat pe contul sau echipa corecta'],
  mewe: ['Textul e lipit', 'Imaginile sunt atasate', 'Postarea e publicata pe profil sau in grupul din campurile de mai sus'],
  skool: ['Grupul si categoria sunt cele din campurile de mai sus', 'Titlul si textul (cel mult 5000 de caractere) sunt copiate', 'Postarea e publicata'],
  whop: ['Compania si forumul sunt cele din campurile de mai sus', 'Titlul si textul sunt copiate', 'Postarea e publicata in forum'],
  moltbook: ['Textul e lipit (cel mult 300 de caractere)', 'Submolt-ul e cel din campurile de mai sus', 'Postarea e publicata'],
  kick: ['Mesajul (cel mult 500 de caractere) e trimis in chatul canalului', 'Doar text: imaginile nu se trimit in chat'],
  twitch: ['Mesajul (cel mult 500 de caractere) e trimis in chat sau ca anunt', 'Doar text: imaginile nu se trimit in chat'],
  tiktok: [
    'Imaginile (cel mult 35, latura mica cel mult 1080) sunt incarcate ca postare cu poze',
    'Titlul (cel mult 90 de caractere) si descrierea sunt copiate',
    'Vizibilitatea e cea din campurile de mai sus',
    'Postarea e publicata',
  ],
  youtube: [
    'Videoclipul este incarcat (aplicatia nu face filme)',
    'Titlul (cel mult 100 de caractere) si descrierea sunt copiate',
    'Etichetele sunt adaugate',
    'Imaginea de coperta (miniatura) e incarcata, daca exista',
    'Videoclipul e publicat sau programat',
  ],
  // Amendment 05: manual-only channels.
  quora: [
    'Intrebarea sau Space-ul sunt cele din campurile de mai sus',
    'Raspunsul raspunde intrebarii si nu e doar o reclama',
    'Textul e lipit si recitit; imaginea e atasata, daca exista',
    'Raspunsul e publicat si linkul lui e salvat',
  ],
  'linkedin-article': [
    'Titlul (cel mult 100 de caractere) si subtitlul sunt copiate',
    'Corpul articolului e lipit si arata bine in previzualizare',
    'Coperta e incarcata',
    'Articolul sau numarul de newsletter e publicat pe profilul sau pagina corecta',
    'Linkul articolului e salvat',
  ],
  tradingview: [
    'Simbolul din campurile de mai sus e deschis in grafic',
    'Graficul e desenat sau imaginea cardului e atasata',
    'Titlul ideii si descrierea sunt copiate',
    'Ideea e publicata (sau Mind-ul trimis) si linkul ei e salvat',
  ],
  investing: [
    'Pagina instrumentului este cea din campurile de mai sus',
    'Textul e lipit si recitit; comentariul respecta regulile comunitatii',
    'Postarea e publicata si linkul ei e salvat',
  ],
  indiehackers: [
    'Titlul e copiat si grupul e ales, daca exista',
    'Textul e lipit si arata bine in previzualizare',
    'Postarea e publicata si linkul ei e salvat',
  ],
  stackexchange: [
    'Site-ul si tipul (raspuns sau intrebare) sunt cele din campurile de mai sus',
    'Afilierea este declarata in raspuns (regula de autopromovare Stack Exchange)',
    'Raspunsul raspunde intrebarii; linkurile spre noi sunt doar completari, nu raspunsul',
    'Pentru o intrebare: titlul (15 pana la 150 de caractere) si cel mult 5 etichete sunt completate',
    'Postarea e publicata si linkul ei e salvat',
  ],
  github: [
    'Repository-ul si tipul (release sau discutie) sunt cele din campurile de mai sus',
    'Pentru release: tag-ul exista sau e creat, iar titlul e copiat',
    'Pentru discutie: categoria e aleasa',
    'Descrierea e lipita si arata bine in previzualizare',
    'Release-ul sau discutia e publicat si linkul e salvat',
  ],
  forum: [
    'Forumul este cel al contului si regulile lui permit postarea',
    'Firul (raspuns) sau titlul (fir nou) sunt cele din campurile de mai sus',
    'Textul e lipit si recitit',
    'Postarea e publicata si linkul ei e salvat',
  ],
  press: [
    'Comunicatul e trimis redactiei, pe pagina de contact a publicatiei',
    'Titlul, leadul si paragraful "Despre" sunt incluse',
    'Urmarirea: redactia a confirmat primirea sau am revenit dupa cateva zile',
    'Linkul articolului aparut e salvat',
  ],
}

/** "declaratia-unica-substack.md" */
export function downloadName(title: string | null, platform: Platform, ext: 'txt' | 'md' | 'html'): string {
  const base = (title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${base || 'postare'}-${platform}.${ext}`
}

/** A standalone HTML file for the download (the copy button gives only the fragment). */
export function htmlDocument(title: string | null, fragment: string): string {
  return `<!doctype html>\n<html lang="ro">\n<head>\n<meta charset="utf-8">\n<title>${escapeHtml(title ?? 'Postare')}</title>\n</head>\n<body>\n${fragment}\n</body>\n</html>\n`
}

export function platformLabel(p: Platform): string {
  return PLATFORM_LABELS[p]
}
