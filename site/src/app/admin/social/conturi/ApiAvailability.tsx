import { Card } from '@/components/ui'
import { PLATFORM_LABELS } from '@/lib/social/constants'
import { apiAvailability, INACTIVE_API_PLATFORMS } from '@/lib/native/capabilities'

export function ApiAvailability() {
  return <Card><details><summary className="cursor-pointer font-bold">Alte platforme — publicare API neactiva ({INACTIVE_API_PLATFORMS.length})</summary>
    <p className="my-3 text-sm text-ink-soft">Aceste platforme sunt separate de conexiunile automate. Fiecare are nevoie de verificarea accesului sau de un conector suplimentar.</p>
    <dl className="divide-y divide-line">{INACTIVE_API_PLATFORMS.map(platform => <div key={platform} className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr]">
      <dt className="font-semibold">{PLATFORM_LABELS[platform]}</dt><dd className="text-sm text-ink-soft">{apiAvailability(platform).reason}</dd>
    </div>)}</dl>
  </details></Card>
}
