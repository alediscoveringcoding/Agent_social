import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'

/**
 * Runs before every page (not the worker API, not static files):
 *  1. a fresh CSP nonce per request (Next applies it to its own scripts);
 *  2. the Supabase session refresh (cookies);
 *  3. a cheap first gate: no session on /admin means /login. The real check
 *     (allowlist + TOTP/aal2) is requireAdminPage()/requireAdmin(), on the
 *     render path and inside every action.
 */

function contentSecurityPolicy(nonce: string): string {
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const dev = process.env.NODE_ENV === 'development'
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? ` 'unsafe-eval'` : ''}`,
    // Inline style attributes (React style={...}, the toast library) need this.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data: ${supabase}`.trim(),
    `font-src 'self'`,
    `connect-src 'self' ${supabase}`.trim(),
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ].join('; ')
}

export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const csp = contentSecurityPolicy(nonce)
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp)
  // Always overwritten here, so a client-sent value never gets through. The
  // admin layout reads it to send people back to the page they asked for.
  requestHeaders.set('x-pathname', request.nextUrl.pathname + request.nextUrl.search)

  let response = NextResponse.next({ request: { headers: requestHeaders } })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  let signedIn = false
  if (url && anon) {
    const supabase = createServerClient(url, anon, {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(toSet) {
          for (const { name, value } of toSet) request.cookies.set(name, value)
          // requestHeaders was copied before the refresh: give the render the new
          // cookies too, or it sees the old token and refreshes a second time with
          // an already used refresh token.
          requestHeaders.set('cookie', request.headers.get('cookie') ?? '')
          response = NextResponse.next({ request: { headers: requestHeaders } })
          for (const { name, value, options } of toSet) response.cookies.set(name, value, options)
        },
      },
    })
    const {
      data: { user },
    } = await supabase.auth.getUser()
    signedIn = !!user
  }

  const path = request.nextUrl.pathname
  if (path.startsWith('/admin') && !signedIn) {
    const login = new URL('/login', request.url)
    login.searchParams.set('next', path + request.nextUrl.search)
    const redirect = NextResponse.redirect(login)
    redirect.headers.set('Content-Security-Policy', csp)
    return redirect
  }

  response.headers.set('Content-Security-Policy', csp)
  return response
}

export const config = {
  matcher: [
    {
      source: '/((?!api/worker|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|webp|woff2?)$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
