import type { Metadata } from 'next'
import '@fontsource/plus-jakarta-sans/latin-400.css'
import '@fontsource/plus-jakarta-sans/latin-600.css'
import '@fontsource/plus-jakarta-sans/latin-700.css'
import '@fontsource/plus-jakarta-sans/latin-800.css'
import './globals.css'

export const metadata: Metadata = {
  title: { default: 'Social · Taxes Support', template: '%s · Social' },
  robots: { index: false, follow: false },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ro">
      <body className="min-h-screen bg-bg text-ink">{children}</body>
    </html>
  )
}
