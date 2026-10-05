'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/components/ui'

const ITEMS = [
  { href: '/admin/social', label: 'Prezentare', exact: true },
  { href: '/admin/social/genereaza', label: 'Genereaza' },
  { href: '/admin/social/ciorne', label: 'Ciorne' },
  // W3: navigation for the completed publishing flow (W1/W2 pages included).
  { href: '/admin/social/postari', label: 'Postari' },
  { href: '/admin/social/calendar', label: 'Calendar' },
  { href: '/admin/social/manual', label: 'Manual' },
  { href: '/admin/social/media', label: 'Media' },
  { href: '/admin/social/conturi', label: 'Conturi' },
]

export function AdminNav() {
  const path = usePathname()
  return (
    <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label="Social">
      {ITEMS.map((item) => {
        const active = item.exact ? path === item.href : path === item.href || path.startsWith(`${item.href}/`)
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'rounded-lg px-3 py-1.5 font-semibold',
              active ? 'bg-accent-soft text-accent-dark' : 'text-ink-soft hover:bg-bg-mint hover:text-ink'
            )}
          >
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
