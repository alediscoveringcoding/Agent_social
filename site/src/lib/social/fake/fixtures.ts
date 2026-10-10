/**
 * Draft fixtures for the fake generator (PRD 10.5 Draft shape). Romanian, no
 * diacritics, like real drafts, plus drafts that break one rule each so every
 * validation message can be seen in the composer:
 *
 *   clean-deadline   passes everything (figures sourced)
 *   diacritics       "ș" and "ț" in the text (DIACRITICS)
 *   unverified       a figure with source "unverified" (UNVERIFIED_FIGURE)
 *   x-too-long       X text over 280 weighted characters (TOO_LONG)
 *   ig-link          link and bare domain in the Instagram caption (IG_URL, BARE_DOMAIN)
 *   banned           "profit sigur" (BANNED_PHRASE)
 *   article          dev.to / Hashnode / Substack / Medium article with canonical URL
 *   launch           Product Hunt launch kit
 *   more-platforms   Threads, Bluesky, Mastodon, LinkedIn (profile), Reddit,
 *                    Pinterest, Telegram, Discord, Farcaster, Nostr, Lemmy
 *   every-platform   Slack, VK, Google Business, Tumblr, Dribbble, MeWe, Skool,
 *                    Whop, Moltbook, Kick, Twitch, TikTok, YouTube (manual: video)
 *
 * Every entry carries the generator's own `validation_errors` the way the
 * real generator reports a draft it could not repair.
 */

import type { DraftWire } from '../schemas.ts'

type Fixture = Omit<DraftWire, 'client_ref'> & { name: string }

const card = (headline: string, keyword: string, stat: string | null, template: 'light' | 'dark' | 'mint') => ({
  template,
  headline,
  keyword,
  stat,
  subline: 'Afla pe scurt ce inseamna pentru tine si ce ai de facut.',
  brand: 'taxes-support',
  alt_text: `Card: ${headline}${stat ? `, ${stat}` : ''}`,
})

export const DRAFT_FIXTURES: Fixture[] = [
  {
    name: 'clean-deadline',
    kind: 'social',
    title: 'Declaratia Unica: termen 25 mai',
    canonical_text: 'Ai pana pe 25 mai sa depui Declaratia Unica pentru castigurile din 2025.',
    source_url: 'https://thecrypto.support/ghid/declaratia-unica',
    variants: [
      { platform: 'x', text: 'Ai pana pe 25 mai sa depui Declaratia Unica. Ghidul pas cu pas: https://thecrypto.support/ghid/declaratia-unica', settings: {} },
      { platform: 'instagram', text: 'Termenul pentru Declaratia Unica este 25 mai. Pasii sunt in ghidul din bio.', settings: { post_type: 'post' } },
      { platform: 'linkedin-page', text: 'Declaratia Unica se depune pana pe 25 mai. Am pus intr-un ghid scurt ce trebuie sa stii despre castigurile din crypto: https://thecrypto.support/ghid/declaratia-unica', settings: {} },
      { platform: 'facebook', text: 'Ai pana pe 25 mai sa depui Declaratia Unica. Iti explicam calm, pas cu pas: https://thecrypto.support/ghid/declaratia-unica', settings: {} },
    ],
    article: null,
    launch: null,
    card: card('Declaratia Unica se depune pana pe 25 mai', '25 mai', '25 mai', 'dark'),
    figures: [{ value: '25 mai', context: 'termen Declaratia Unica', source: 'facts' }, { value: '2025', context: 'anul veniturilor', source: 'facts' }],
    validation_errors: [],
    notes: 'Varianta de baza pentru termen.',
  },
  {
    name: 'diacritics',
    kind: 'social',
    title: 'Știai asta despre impozit?',
    canonical_text: 'Știai că impozitul se calculează pe câștig, nu pe sumă?',
    source_url: null,
    variants: [
      { platform: 'x', text: 'Știai că impozitul se calculează pe câștig, nu pe toată suma?', settings: {} },
      { platform: 'facebook', text: 'Impozitul se calculează pe câștig. Îți arătăm cum.', settings: {} },
    ],
    article: null,
    launch: null,
    card: card('Impozitul se calculeaza pe castig', 'castig', null, 'light'),
    figures: [],
    validation_errors: [{ code: 'DIACRITICS', message: 'Textul contine diacritice; repararea automata nu a reusit.' }],
    notes: 'Fixture: diacritice.',
  },
  {
    name: 'unverified',
    kind: 'social',
    title: 'Plafonul pentru castiguri mici',
    canonical_text: 'Castigurile sub 600 lei pe tranzactie nu se impoziteaza.',
    source_url: null,
    variants: [
      { platform: 'linkedin-page', text: 'Castigurile sub 600 lei pe tranzactie nu se impoziteaza, daca totalul anual ramane sub 200 lei.', settings: {} },
      { platform: 'x', text: 'Sub 600 lei pe tranzactie, castigul nu se impoziteaza.', settings: {} },
    ],
    article: null,
    launch: null,
    card: card('Castigurile mici au un plafon', 'plafon', '600 lei', 'mint'),
    figures: [
      { value: '600 lei', context: 'plafon pe tranzactie', source: 'unverified' },
      { value: '200 lei', context: 'plafon anual', source: 'unverified' },
    ],
    validation_errors: ['Cifrele 600 lei si 200 lei nu apar in facts.yaml.'],
    notes: 'Fixture: cifre fara sursa.',
  },
  {
    name: 'x-too-long',
    kind: 'social',
    title: 'Ce documente iti trebuie',
    canonical_text: 'O lista cu documentele de care ai nevoie pentru declaratie.',
    source_url: null,
    variants: [
      {
        platform: 'x',
        text:
          'Pentru declaratie ai nevoie de: extrasele de la fiecare exchange, istoricul complet al tranzactiilor, ' +
          'confirmarile de transfer intre portofele, dovada costului de achizitie pentru fiecare moneda, calculul ' +
          'castigului net pe anul fiscal si, nu in ultimul rand, rabdare. Am facut o lista completa ca sa nu uiti nimic.',
        settings: {},
      },
      { platform: 'linkedin-page', text: 'O lista cu documentele de care ai nevoie pentru declaratie, ca sa nu uiti nimic.', settings: {} },
    ],
    article: null,
    launch: null,
    card: card('Ce documente iti trebuie pentru declaratie', 'documente', null, 'light'),
    figures: [],
    validation_errors: [{ code: 'TOO_LONG', message: 'Varianta X are peste 280 de caractere.' }],
    notes: 'Fixture: X prea lung.',
  },
  {
    name: 'ig-link',
    kind: 'social',
    title: 'Ghidul complet',
    canonical_text: 'Ghidul complet despre taxe pe crypto.',
    source_url: 'https://thecrypto.support/ghid/taxe-crypto',
    variants: [
      { platform: 'instagram', text: 'Ghidul complet e pe thecrypto.support: https://thecrypto.support/ghid/taxe-crypto', settings: { post_type: 'post' } },
      { platform: 'facebook', text: 'Ghidul complet despre taxe pe crypto: https://thecrypto.support/ghid/taxe-crypto', settings: {} },
    ],
    article: null,
    launch: null,
    card: card('Tot ce trebuie sa stii despre taxe pe crypto', 'taxe', null, 'mint'),
    figures: [],
    validation_errors: [],
    notes: 'Fixture: link si domeniu in descrierea de Instagram.',
  },
  {
    name: 'banned',
    kind: 'social',
    title: 'Profit sigur?',
    canonical_text: 'Nu exista profit sigur. Exista impozit sigur.',
    source_url: null,
    variants: [
      { platform: 'x', text: 'Nu exista profit sigur. Exista insa un impozit pe care il poti calcula corect.', settings: {} },
      { platform: 'linkedin-page', text: 'Nu exista profit sigur, dar exista reguli clare pentru impozit.', settings: {} },
    ],
    article: null,
    launch: null,
    card: card('Impozitul se poate calcula corect', 'corect', null, 'dark'),
    figures: [],
    validation_errors: [],
    notes: 'Fixture: expresie interzisa ("profit sigur").',
  },
  {
    name: 'article',
    kind: 'article',
    title: 'Cum calculezi impozitul pe crypto',
    canonical_text: 'Un ghid pas cu pas pentru calculul impozitului pe castigurile din crypto.',
    source_url: 'https://thecrypto.support/ghid/impozit-crypto',
    variants: [
      { platform: 'devto', text: '', settings: {} },
      { platform: 'hashnode', text: '', settings: {} },
      { platform: 'substack', text: '', settings: {} },
      { platform: 'medium', text: '', settings: {} },
      { platform: 'wordpress', text: '', settings: {} },
      { platform: 'listmonk', text: '', settings: {} },
    ],
    article: {
      title: 'Cum calculezi impozitul pe crypto',
      subtitle: 'Pas cu pas, fara surprize',
      body_markdown:
        '# Cum calculezi impozitul pe crypto\n\nPasul 1: exporta tranzactiile de pe fiecare platforma.\n\n' +
        'Pasul 2: calculeaza castigul pentru fiecare vanzare.\n\nPasul 3: aduna castigurile si depune declaratia.\n',
      tags: ['crypto', 'taxe', 'romania'],
      canonical_url: 'https://thecrypto.support/ghid/impozit-crypto',
    },
    launch: null,
    card: card('Cum calculezi impozitul pe crypto', 'impozitul', null, 'light'),
    figures: [],
    validation_errors: [],
    notes: 'Fixture: articol pentru dev.to, Hashnode, Substack, Medium, WordPress si Listmonk.',
  },
  {
    name: 'every-platform',
    kind: 'social',
    title: 'Declaratia Unica, pentru restul platformelor',
    canonical_text: 'Ai pana pe 25 mai sa depui Declaratia Unica pentru castigurile din 2025.',
    source_url: 'https://thecrypto.support/ghid/declaratia-unica',
    variants: [
      { platform: 'slack', text: 'Reminder pentru echipa: Declaratia Unica se depune pana pe 25 mai. Ghid: https://thecrypto.support/ghid/declaratia-unica', settings: {} },
      { platform: 'vk', text: 'Declaratia Unica se depune pana pe 25 mai. Ghidul pas cu pas: https://thecrypto.support/ghid/declaratia-unica', settings: {} },
      { platform: 'gmb', text: 'Ajutor la Declaratia Unica pentru castigurile din crypto. Termenul este 25 mai.', settings: {} },
      {
        platform: 'tumblr',
        text: 'Ai pana pe 25 mai sa depui Declaratia Unica. Am strans pasii intr-un ghid scurt.',
        settings: { title: 'Declaratia Unica: termenul este 25 mai', link: 'https://thecrypto.support/ghid/declaratia-unica' },
      },
      {
        platform: 'dribbble',
        text: 'Cardul pentru termenul Declaratiei Unice, in trei variante de culoare.',
        settings: { title: 'Declaratia Unica, 25 mai' },
      },
      { platform: 'mewe', text: 'Declaratia Unica se depune pana pe 25 mai. Iti explicam calm, pas cu pas.', settings: {} },
      {
        platform: 'skool',
        text: 'Termenul pentru Declaratia Unica este 25 mai. Mai jos sunt pasii pentru castigurile din crypto din 2025.',
        settings: { title: 'Declaratia Unica: ce faci pana pe 25 mai' },
      },
      {
        platform: 'whop',
        text: 'Termenul pentru Declaratia Unica este 25 mai. Pasii pentru castigurile din crypto din 2025, pe scurt.',
        settings: { title: 'Declaratia Unica: termenul' },
      },
      { platform: 'moltbook', text: 'Declaratia Unica se depune pana pe 25 mai. Iti explicam pasii calm.', settings: {} },
      { platform: 'kick', text: 'Reminder: Declaratia Unica se depune pana pe 25 mai.', settings: {} },
      { platform: 'twitch', text: 'Reminder: Declaratia Unica se depune pana pe 25 mai.', settings: {} },
      {
        platform: 'tiktok',
        text: 'Declaratia Unica se depune pana pe 25 mai. Pasii pentru castigurile din crypto, pe scurt.',
        settings: { title: 'Declaratia Unica: termen 25 mai' },
      },
      {
        platform: 'youtube',
        text: 'Cum depui Declaratia Unica pentru castigurile din crypto, pas cu pas. Termenul este 25 mai.',
        settings: { title: 'Declaratia Unica pentru crypto, pas cu pas' },
      },
    ],
    article: null,
    launch: null,
    card: card('Declaratia Unica se depune pana pe 25 mai', '25 mai', '25 mai', 'light'),
    figures: [
      { value: '25 mai', context: 'termen Declaratia Unica', source: 'facts' },
      { value: '2025', context: 'anul veniturilor', source: 'facts' },
    ],
    validation_errors: [],
    notes:
      'Fixture: restul platformelor Postiz. Slack, Skool, Whop, MeWe, Google Business si Dribbble cer inca un camp; Dribbble si TikTok cer imaginea; YouTube cere video, deci merge manual.',
  },
  {
    name: 'more-platforms',
    kind: 'social',
    title: 'Declaratia Unica pe mai multe platforme',
    canonical_text: 'Ai pana pe 25 mai sa depui Declaratia Unica pentru castigurile din 2025.',
    source_url: 'https://thecrypto.support/ghid/declaratia-unica',
    variants: [
      { platform: 'threads', text: 'Ai pana pe 25 mai sa depui Declaratia Unica. Iti explicam calm, pas cu pas.', settings: {} },
      {
        platform: 'bluesky',
        text: 'Ai pana pe 25 mai sa depui Declaratia Unica. Ghid pas cu pas: https://thecrypto.support/ghid/declaratia-unica',
        settings: {},
      },
      {
        platform: 'mastodon',
        text: 'Declaratia Unica se depune pana pe 25 mai. Am scris un ghid scurt: https://thecrypto.support/ghid/declaratia-unica',
        settings: {},
      },
      {
        platform: 'linkedin',
        text: 'Declaratia Unica se depune pana pe 25 mai. Am pus intr-un ghid scurt ce trebuie sa stii despre castigurile din crypto: https://thecrypto.support/ghid/declaratia-unica',
        settings: {},
      },
      {
        platform: 'reddit',
        text: 'Termenul pentru Declaratia Unica este 25 mai. Am adunat intr-un ghid pasii pentru castigurile din crypto din 2025.',
        settings: { post_type: 'self', title: 'Declaratia Unica: termenul este 25 mai, iata pasii pentru crypto' },
      },
      {
        platform: 'pinterest',
        text: 'Declaratia Unica se depune pana pe 25 mai. Pasii pentru castigurile din crypto, pe scurt.',
        settings: { title: 'Declaratia Unica: termen 25 mai', link: 'https://thecrypto.support/ghid/declaratia-unica' },
      },
      {
        platform: 'telegram',
        text: 'Ai pana pe 25 mai sa depui Declaratia Unica. Ghidul pas cu pas: https://thecrypto.support/ghid/declaratia-unica',
        settings: {},
      },
      {
        platform: 'discord',
        text: 'Reminder: Declaratia Unica se depune pana pe 25 mai. Ghid: https://thecrypto.support/ghid/declaratia-unica',
        settings: {},
      },
      { platform: 'farcaster', text: 'Declaratia Unica se depune pana pe 25 mai. Ghid pas cu pas in linkul de mai jos.', settings: {} },
      { platform: 'nostr', text: 'Ai pana pe 25 mai sa depui Declaratia Unica. Iti explicam pas cu pas, fara stres.', settings: {} },
      {
        platform: 'lemmy',
        text: 'Termenul pentru Declaratia Unica este 25 mai. Ghidul are pasii pentru castigurile din crypto din 2025.',
        settings: { title: 'Declaratia Unica: termenul este 25 mai' },
      },
    ],
    article: null,
    launch: null,
    card: card('Declaratia Unica se depune pana pe 25 mai', '25 mai', '25 mai', 'mint'),
    figures: [
      { value: '25 mai', context: 'termen Declaratia Unica', source: 'facts' },
      { value: '2025', context: 'anul veniturilor', source: 'facts' },
    ],
    validation_errors: [],
    notes:
      'Fixture: platformele din amendamentul 04. Reddit, Pinterest, Discord si Lemmy cer inca un camp (subreddit, board, canal, comunitate); Pinterest cere si imaginea.',
  },
  {
    name: 'manual-channels',
    kind: 'social',
    title: 'Declaratia Unica, pentru canalele manuale',
    canonical_text: 'Ai pana pe 25 mai sa depui Declaratia Unica pentru castigurile din 2025.',
    source_url: 'https://thecrypto.support/ghid/declaratia-unica',
    variants: [
      { platform: 'quora', text: 'Termenul pentru Declaratia Unica este 25 mai. Poti sa o depui online, iar castigurile din crypto intra la venituri din transferul activelor digitale.', settings: {} },
      { platform: 'tradingview', text: 'Termenul fiscal din 25 mai conteaza si pentru cei care tranzactioneaza: pastreaza extrasele de la exchange.', settings: { title: 'Termenul fiscal din 25 mai pentru castigurile crypto' } },
      { platform: 'investing', text: 'Reminder: Declaratia Unica se depune pana pe 25 mai, inclusiv pentru castigurile din crypto.', settings: {} },
      { platform: 'indiehackers', text: 'Am construit un ghid scurt pentru Declaratia Unica. Termenul este 25 mai, iar pasii sunt aceiasi pentru toti.', settings: { title: 'Un ghid scurt pentru Declaratia Unica din Romania' } },
      { platform: 'stackexchange', text: 'Termenul este 25 mai. Sunt afiliat cu Taxes Support, care a scris un ghid cu pasii: https://thecrypto.support/ghid/declaratia-unica', settings: {} },
      { platform: 'forum', text: 'Reminder: Declaratia Unica se depune pana pe 25 mai. Ghidul pas cu pas: https://thecrypto.support/ghid/declaratia-unica', settings: { title: 'Declaratia Unica 2026: ce faceti cu crypto?' } },
    ],
    article: null,
    launch: null,
    card: card('Declaratia Unica se depune pana pe 25 mai', '25 mai', '25 mai', 'dark'),
    figures: [
      { value: '25 mai', context: 'termen Declaratia Unica', source: 'facts' },
      { value: '2025', context: 'anul veniturilor', source: 'facts' },
    ],
    validation_errors: [],
    notes: 'Fixture: canale manuale (amendamentul 05). Intrebarea, simbolul, instrumentul sau firul se aleg de o persoana; Stack Exchange cere afilierea declarata.',
  },
  {
    name: 'manual-articles',
    kind: 'article',
    title: 'Comunicat: Taxes Support lanseaza un ghid pentru Declaratia Unica',
    canonical_text: 'Taxes Support publica un ghid pas cu pas pentru Declaratia Unica.',
    source_url: 'https://thecrypto.support/ghid/declaratia-unica',
    variants: [
      { platform: 'linkedin-article', text: '', settings: {} },
      { platform: 'github', text: '', settings: {} },
      { platform: 'press', text: '', settings: {} },
    ],
    article: {
      title: 'Taxes Support lanseaza un ghid pentru Declaratia Unica',
      subtitle: 'Pasii pentru castigurile din crypto, explicati calm',
      body_markdown:
        '# Taxes Support lanseaza un ghid pentru Declaratia Unica\n\nGhidul explica pas cu pas cum se depune declaratia pentru castigurile din crypto.\n\n' +
        'Termenul este 25 mai.\n\n## Despre Taxes Support\n\nTaxes Support ajuta oamenii sa isi inteleaga impozitele pe crypto.\n',
      tags: [],
      canonical_url: 'https://thecrypto.support/ghid/declaratia-unica',
    },
    launch: null,
    card: card('Ghid pentru Declaratia Unica', 'Declaratia', null, 'mint'),
    figures: [{ value: '25 mai', context: 'termen Declaratia Unica', source: 'facts' }],
    validation_errors: [],
    notes: 'Fixture: articol, comunicat de presa si release pentru canalele manuale (amendamentul 05). Repository-ul si tag-ul se aleg de o persoana.',
  },
  {
    name: 'launch',
    kind: 'launch',
    title: 'Taxes Support pe Product Hunt',
    canonical_text: 'Taxes Support calculeaza impozitul pe crypto din extrasele tale.',
    source_url: null,
    variants: [{ platform: 'producthunt', text: '', settings: {} }],
    article: null,
    launch: {
      name: 'Taxes Support',
      tagline: 'Impozitul pe crypto, calculat din extrasele tale',
      description: 'Incarci extrasele de la exchange-uri, primesti calculul castigului si declaratia completata. Fara foi de calcul.',
      maker_comment: 'Salut! Am construit Taxes Support pentru ca ne-am saturat de foi de calcul la fiecare declaratie.',
    },
    card: card('Impozitul pe crypto, calculat din extrase', 'calculat', null, 'mint'),
    figures: [],
    validation_errors: [],
    notes: 'Fixture: kit de lansare Product Hunt.',
  },
]

/**
 * What the research step would hand over for a request that asks for it
 * (amendment 07): a few web pages, example.com only, never a real site.
 */
export function researchSources(): NonNullable<DraftWire['sources']> {
  return [
    {
      url: 'https://example.com/stiri/declaratia-unica-termen',
      title: 'Termenul pentru Declaratia Unica a fost reamintit',
      publisher: 'Example News',
      published_at: '4 mai 2026',
      note: 'Confirma termenul de depunere din 25 mai.',
      found_in_search: true,
    },
    {
      url: 'https://example.com/stiri/impozit-crypto-explicat',
      title: 'Impozitul pe castigurile din crypto, explicat',
      publisher: 'Example Finance',
      published_at: '28 aprilie 2026',
      note: 'Sustine cota de impozit pomenita in ciorna.',
      found_in_search: true,
    },
    {
      url: 'https://example.com/ghiduri/declaratie-pas-cu-pas',
      title: 'Declaratia pas cu pas',
      publisher: 'Example Guides',
      published_at: null,
      note: null,
      found_in_search: true,
    },
  ]
}

/** The figure a web page gave the draft: unverified until a person confirms it. */
export function researchFigure(): NonNullable<DraftWire['figures']>[number] {
  return {
    value: '16%',
    context: 'cota de impozit citata dintr-un articol recent',
    source: 'unverified',
    source_url: 'https://example.com/stiri/impozit-crypto-explicat',
  }
}

/** A draft as the researching generator would deliver it: sources, and one unverified web figure. */
export function withResearch(draft: DraftWire): DraftWire {
  return {
    ...draft,
    sources: researchSources(),
    figures: [...(draft.figures ?? []), researchFigure()],
  }
}

/** Drafts for a request: fixtures rotated, variants limited to the requested platforms. */
export function draftsFor(platforms: readonly string[], count: number, offset = 0): DraftWire[] {
  const usable = DRAFT_FIXTURES.filter((f) => f.variants.some((v) => platforms.includes(v.platform)))
  const pool = usable.length ? usable : DRAFT_FIXTURES.slice(0, 1)
  const out: DraftWire[] = []
  for (let i = 0; i < count; i++) {
    const { name: _name, ...f } = pool[(i + offset) % pool.length]
    const variants = f.variants.filter((v) => platforms.includes(v.platform))
    out.push({ ...f, client_ref: String(i + 1), variants: variants.length ? variants : f.variants })
  }
  return out
}
