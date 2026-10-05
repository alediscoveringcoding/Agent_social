/**
 * Resolution hooks for `npm test` (node:test with type stripping):
 *
 *  - `@/x` resolves to `src/x(.ts|.tsx|/index.ts)`, as tsconfig's `paths` does;
 *  - `server-only` is an empty module (outside Next it would throw);
 *  - `next/cache` becomes no-ops (revalidatePath needs a Next request);
 *  - `@/lib/supabase/admin` becomes a client backed by the test's PGlite, and
 *    `@/lib/auth/admin` a guard the test controls (src/lib/testing/).
 *
 * Production code is untouched: the swap happens only under this loader.
 */
import { existsSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

const SHIMS = {
  '@/lib/supabase/admin': join(SRC, 'lib', 'testing', 'admin-shim.ts'),
  '@/lib/auth/admin': join(SRC, 'lib', 'testing', 'auth-shim.ts'),
}

const dataModule = (code) => `data:text/javascript,${encodeURIComponent(code)}`

const STUBS = {
  'server-only': dataModule('export {}'),
  'next/cache': dataModule(
    'export function revalidatePath() {} export function revalidateTag() {} export function updateTag() {} export function refresh() {}'
  ),
}

function isFile(p) {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier in STUBS) return { url: STUBS[specifier], shortCircuit: true }
  if (specifier in SHIMS) return { url: pathToFileURL(SHIMS[specifier]).href, shortCircuit: true }
  if (specifier.startsWith('@/')) {
    const base = join(SRC, specifier.slice(2))
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
      if (isFile(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}
