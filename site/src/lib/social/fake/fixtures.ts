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
 *   article          dev.to / Hashnode / Substack article with canonical URL
 *   launch           Product Hunt launch kit
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
    notes: 'Fixture: articol pentru dev.to, Hashnode si Substack.',
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
