'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/components/ui'

const ITEMS = [
  { href: '/admin/social', label: 'Prezentare', exact: true },
  { href: '/admin/social/genereaza', label: 'Genereaza' },
  { href: '/admin/social/ciorne', label: 'Ciorne' },
]

export function AdminNav() {
  const path = usePathname()
  return (
    <nav className="flex items-center gap-1 text-sm">
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
