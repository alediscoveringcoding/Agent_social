import type { DraftDestination } from '@/lib/social/queries'
import { PLATFORM_LABELS, type Platform } from '@/lib/social/constants'
import { Card } from '@/components/ui'

export function DestinationPreview({ accountName, platform, text, settings, media }: { accountName: string; platform: Platform; text: string; settings: Record<string, unknown>; media: DraftDestination['media'] }) {
  return <Card><p className="text-xs font-bold uppercase tracking-wide text-ink-soft">Previzualizare · {PLATFORM_LABELS[platform]}</p><div className="mt-3 rounded-lg border border-line bg-bg p-3"><p className="text-sm font-bold text-ink">{accountName}</p>{typeof settings.title === 'string' ? <p className="mt-1 font-bold">{settings.title}</p> : null}{typeof settings.name === 'string' ? <p className="mt-1 font-bold">{settings.name}</p> : null}{typeof settings.tagline === 'string' ? <p className="text-sm">{settings.tagline}</p> : null}<p className="mt-1 whitespace-pre-wrap break-words text-sm text-ink">{text || '…'}</p>{media.map((m) => m.url ? <img key={m.media_id} src={m.url} alt={m.alt_text} className="mt-2 w-full rounded-lg border border-line" /> : null /* eslint-disable-line @next/next/no-img-element */)}</div></Card>
}
