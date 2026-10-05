/**
 * TEMPORARY local mode, until the app runs on a local Supabase: DB_MODE=local
 * keeps the database in PGlite files under site/.local-db/ and replaces
 * Supabase Auth with a local login (password + TOTP). Remove src/lib/local/
 * and every isLocalMode() branch when moving to Supabase.
 */
export function isLocalMode(): boolean {
  return process.env.DB_MODE === 'local'
}
