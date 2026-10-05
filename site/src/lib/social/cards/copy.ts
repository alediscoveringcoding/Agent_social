import { findBannedPhrases, findBareDomains, findDiacritics, findLegalNames } from '../content-rules.ts'
import type { CardSpec } from './spec.ts'

/** The text painted into a card is published copy too. */
export function cardCopyIssues(spec: Pick<CardSpec, 'headline' | 'stat' | 'subline'>, legalNames: readonly string[] = []): string[] {
  const text = [spec.headline, spec.stat, spec.subline].filter(Boolean).join(' ')
  const errors: string[] = []
  if (findDiacritics(text).length) errors.push('Cardul se scrie fara diacritice.')
  if (findBannedPhrases(text).length) errors.push('Cardul contine o expresie interzisa.')
  if (findBareDomains(text).length) errors.push('Domeniul din card apare doar intr-un link (https://...).')
  if (findLegalNames(text, legalNames).length) errors.push('Numele firmei operatorului nu apare in card.')
  return errors
}
