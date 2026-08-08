/**
 * Sign out, from anywhere.
 *
 * Two steps, in this order and deliberately: tell the server to revoke, then
 * clear local storage. The local clear is unconditional — if the revoke call
 * fails (offline, server down, token already expired) the user must still end
 * up signed out on this device rather than stuck in a session they asked to
 * leave.
 */

import { api } from './api'
import * as session from './session'

export async function signOut(): Promise<void> {
  try {
    await api.logout()
  } catch {
    /* best effort: a failed revoke must never block signing out locally */
  }
  session.clear()
}
