import { Card } from '@/components/ui'
import { DROPPED_PLATFORM_NOTE, EXCLUDED_PLATFORM_NOTE, PLATFORM_LABELS } from '@/lib/social/constants'
import { apiAvailability, EXCLUDED_NATIVE_PLATFORMS, INACTIVE_API_PLATFORMS, NOT_IMPLEMENTED_PLATFORMS } from '@/lib/native/capabilities'

const names = (platforms: readonly (keyof typeof PLATFORM_LABELS)[]) => platforms.map((platform) => PLATFORM_LABELS[platform]).join(', ')

export function ApiAvailability() {
  return <Card><details><summary className="cursor-pointer font-bold">Alte platforme — publicare API neactiva ({INACTIVE_API_PLATFORMS.length})</summary>
    <p className="my-3 text-sm text-ink-soft">Aceste platforme sunt separate de conexiunile automate. Le poti folosi cu un cont manual din optiunile avansate.</p>
    <dl className="divide-y divide-line">{INACTIVE_API_PLATFORMS.map(platform => <div key={platform} className="grid gap-1 py-3 sm:grid-cols-[12rem_1fr]">
      <dt className="font-semibold">{PLATFORM_LABELS[platform]}</dt><dd className="text-sm text-ink-soft">{apiAvailability(platform).reason}</dd>
    </div>)}</dl>
    <div className="mt-3 border-t border-line pt-3 text-sm text-ink-soft">
      <p><span className="font-semibold text-ink">Neimplementate, scoase din aplicatie:</span> {names(NOT_IMPLEMENTED_PLATFORMS)}. {DROPPED_PLATFORM_NOTE} Nu se pot crea conturi sau ciorne pentru ele.</p>
      <p className="mt-1"><span className="font-semibold text-ink">Excluse:</span> {names(EXCLUDED_NATIVE_PLATFORMS)}. {EXCLUDED_PLATFORM_NOTE}</p>
    </div>
  </details></Card>
}
