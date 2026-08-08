/**
 * Server-side Supabase client, authenticated with the SERVICE-ROLE key.
 *
 * This key bypasses RLS and can write every table, which is exactly what the
 * trading service needs (clients may only SELECT their own rows). It must never
 * reach the browser — that is why it is read from a non-VITE_ env var and this
 * module lives under server/, not src/.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Minimal .env loader (no dependency): fills process.env for keys not already set. */
function loadDotEnv(): void {
  const envPath = resolve(HERE, '..', '.env')
  if (!existsSync(envPath)) return
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let val = m[2]
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (!(m[1] in process.env)) process.env[m[1]] = val
  }
}

export function createAdminClient(): SupabaseClient {
  loadDotEnv()
  // Accept the legacy VITE_-prefixed name as a FALLBACK. Reading it here, on the
  // server, exposes nothing — the exposure risk is Vite inlining VITE_* into the
  // browser bundle at build time, which is a build-config concern, not this one.
  // The fallback exists because dropping it during the auth rewrite crash-looped
  // production: a rename that only lands in code and not in the deploy
  // environment must degrade, not take the server down.
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url) {
    throw new Error('Missing SUPABASE_URL (or legacy VITE_SUPABASE_URL) in the environment')
  }
  if (!serviceKey) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY in .env')

  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
