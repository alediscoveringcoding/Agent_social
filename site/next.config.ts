import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // TEMPORARY local mode (src/lib/local/db.ts): PGlite loads its WASM and data
  // files at runtime, so it is required from node_modules, not bundled.
  serverExternalPackages: ['@electric-sql/pglite'],
  // The card renderer reads these at runtime (see src/lib/social/cards/fonts.ts).
  outputFileTracingIncludes: {
    '/**': ['./node_modules/@fontsource/plus-jakarta-sans/files/plus-jakarta-sans-latin-*-normal.woff'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ]
  },
}

export default nextConfig
