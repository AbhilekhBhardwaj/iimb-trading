/**
 * Shared account/identity helpers for the competition.
 *
 * Teams never type an email — they log in with a short username (e.g. `team01`).
 * Internally that maps to a synthetic address on a domain that receives no real
 * mail, which is what Supabase Auth actually stores. Keeping the mapping here
 * means the provisioning script and the login page derive the exact same email
 * from a username, so they can never drift.
 *
 * This module imports nothing and touches no browser/Node-only globals, so it is
 * safe to import from both the Vite app (login page) and the Node script.
 */

/** Domain for synthetic per-account emails. Not a real mail domain. */
export const EVENT_EMAIL_DOMAIN = 'mochatrade-event.internal'

/** Roles as stored in profiles.role — mirrors the DB `user_role` enum. */
export type AppRole = 'team' | 'market_maker' | 'master'

/** Map a login username to the synthetic email Supabase Auth stores. */
export function usernameToEmail(username: string): string {
  return `${username.trim().toLowerCase()}@${EVENT_EMAIL_DOMAIN}`
}

/** Zero-padded, sortable team username: 1 -> "team01", 12 -> "team12". */
export function teamUsername(teamNumber: number): string {
  return `team${String(teamNumber).padStart(2, '0')}`
}
