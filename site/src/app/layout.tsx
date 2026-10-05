import type { Metadata } from 'next'
import { headers } from 'next/headers'
import '@fontsource/plus-jakarta-sans/latin-400.css'
import '@fontsource/plus-jakarta-sans/latin-600.css'
import '@fontsource/plus-jakarta-sans/latin-700.css'
import '@fontsource/plus-jakarta-sans/latin-800.css'
import './globals.css'

export const metadata: Metadata = {
  title: { default: 'Social · Taxes Support', template: '%s · Social' },
  robots: { index: false, follow: false },
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the request makes every page dynamic, which the CSP nonce needs:
  // a statically prerendered page would ship scripts without one.
  await headers()
  return (
    <html lang="ro">
      <body className="min-h-screen bg-bg text-ink">{children}</body>
    </html>
  )
}
