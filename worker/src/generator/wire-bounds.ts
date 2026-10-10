import type { ValidationError } from './validators.js';
import { PLATFORMS } from '../platforms.js';

/** The site's limits for a draft's sources (DraftSourceSchema) and figure source_url. */
export const SOURCE_LIMITS = { count: 20, url: 2048, title: 300, publisher: 200, published_at: 40, note: 500 } as const;

/** Keep one oversized field from 422-ing an entire otherwise usable batch.
 * Content limits still go through repair; wire limits retain a review error.
 */
export function boundDraftForSite(input: any, errors: ValidationError[]): any {
  const draft = structuredClone(input);
  const issue = (field: string) => errors.push({ rule: 'wire_limit', field, message: `${field} exceeded the site's draft limits; review the shortened value` });
  const text = (object: any, key: string, max: number, field: string) => {
    if (typeof object?.[key] === 'string' && object[key].length > max) {
      issue(field);
      // Do not split a UTF-16 surrogate pair.
      object[key] = object[key].slice(0, max).replace(/[\uD800-\uDBFF]$/, '');
    }
  };
  const list = (object: any, key: string, max: number, field: string) => {
    if (Array.isArray(object?.[key]) && object[key].length > max) { issue(field); object[key] = object[key].slice(0, max); }
  };
  for (const [key, max] of [['title', 300], ['canonical_text', 100000], ['source_url', 2048], ['notes', 4000]] as const) text(draft, key, max, key);
  list(draft, 'variants', PLATFORMS.length, 'variants');
  for (const variant of draft.variants ?? []) {
    text(variant, 'text', 100000, `variants.${variant.platform}`);
    text(variant, 'title', 300, `variants.${variant.platform}.title`);
    text(variant, 'link', 2048, `variants.${variant.platform}.link`);
  }
  if (draft.article) {
    for (const [key, max] of [['title', 300], ['subtitle', 500], ['body_markdown', 200000], ['canonical_url', 2048]] as const) text(draft.article, key, max, `article.${key}`);
    list(draft.article, 'tags', 20, 'article.tags');
    draft.article.tags = draft.article.tags.map((tag: string) => { const row = { tag }; text(row, 'tag', 64, 'article.tags'); return row.tag; });
  }
  if (draft.launch) for (const [key, max] of [['name', 200], ['tagline', 200], ['description', 2000], ['maker_comment', 5000]] as const) text(draft.launch, key, max, `launch.${key}`);
  if (draft.card) for (const [key, max] of [['headline', 200], ['keyword', 200], ['stat', 32], ['subline', 400], ['alt_text', 1000]] as const) text(draft.card, key, max, `card.${key}`);
  list(draft, 'figures', 500, 'figures');
  draft.figures = (draft.figures ?? []).filter((figure: any) => {
    if (!figure.value?.trim()) { issue('figures.value'); return false; }
    text(figure, 'value', 100, 'figures.value'); text(figure, 'context', 500, 'figures.context');
    // A cut URL points at the wrong page, so a too long source_url is dropped, never shortened.
    if (typeof figure.source_url === 'string' && figure.source_url.length > SOURCE_LIMITS.url) { issue('figures.source_url'); delete figure.source_url; }
    return true;
  });
  // Sources are research links a person verifies: a cut URL would be wrong, so that source is dropped.
  if (Array.isArray(draft.sources)) {
    draft.sources = draft.sources.filter((source: any) => {
      if (typeof source?.url !== 'string' || !source.url.trim() || source.url.length > SOURCE_LIMITS.url) { issue('sources.url'); return false; }
      return true;
    });
    list(draft, 'sources', SOURCE_LIMITS.count, 'sources');
    for (const source of draft.sources) {
      for (const key of ['title', 'publisher', 'published_at', 'note'] as const) text(source, key, SOURCE_LIMITS[key], `sources.${key}`);
    }
  }
  return draft;
}
